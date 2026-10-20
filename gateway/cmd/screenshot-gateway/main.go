package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/andrebras/screenshot-server/gateway/internal/gateway"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func number(name string, fallback, min, max int) (int, error) {
	value := env(name, strconv.Itoa(fallback))
	n, err := strconv.Atoi(value)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("%s must be between %d and %d", name, min, max)
	}
	return n, nil
}
func run() error {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	secret := os.Getenv("SCREENSHOT_SERVER_KEY")
	if secret == "" {
		return errors.New("SCREENSHOT_SERVER_KEY is required")
	}
	slots, err := number("RENDER_SLOTS", 2, 1, 64)
	if err != nil {
		return err
	}
	pending, err := number("RENDER_PENDING", 8, 0, 1024)
	if err != nil {
		return err
	}
	maxRequests, err := number("MAX_HTTP_REQUESTS", 256, 1, 10000)
	if err != nil {
		return err
	}
	timeout, err := number("REQUEST_TIMEOUT_MS", 40000, 100, 120000)
	if err != nil {
		return err
	}
	cacheMS, err := number("CACHE_TIMEOUT_MS", 500, 10, 10000)
	if err != nil {
		return err
	}
	ttl, err := number("CACHE_TTL_SECONDS", 86400, 1, 86400)
	if err != nil {
		return err
	}
	port, err := number("PORT", 3001, 1, 65535)
	if err != nil {
		return err
	}
	workerPort, err := number("RENDERER_PORT", 3002, 1, 65535)
	if err != nil {
		return err
	}
	if port == workerPort {
		return errors.New("PORT and RENDERER_PORT must differ")
	}
	version := env("RENDER_VERSION", os.Getenv("APP_REVISION"))
	bucket := os.Getenv("RESULTS_BUCKET")
	if bucket != "" && version == "" {
		return errors.New("RENDER_VERSION or APP_REVISION is required when RESULTS_BUCKET is set")
	}
	var store gateway.Store
	if bucket != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		cfg, e := config.LoadDefaultConfig(ctx, config.WithRetryMaxAttempts(1))
		cancel()
		if e != nil {
			return e
		}
		if cfg.Region == "" {
			return errors.New("AWS_REGION is required with RESULTS_BUCKET")
		}
		store = &gateway.S3Store{Client: s3.NewFromConfig(cfg, func(o *s3.Options) { o.UsePathStyle = os.Getenv("S3_FORCE_PATH_STYLE") == "true" }), Bucket: bucket, Prefix: env("RESULTS_PREFIX", "screenshots/v1/")}
	}
	hosts := map[string]bool{}
	for _, host := range strings.Split(os.Getenv("TRUSTED_RENDER_HOSTS"), ",") {
		if h := strings.ToLower(strings.TrimSpace(host)); h != "" {
			hosts[h] = true
		}
	}
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		return err
	}
	token := hex.EncodeToString(tokenBytes)
	worker := exec.Command(env("NODE_BINARY", "node"), env("RENDERER_SCRIPT", "renderer/index.js"))
	worker.Env = append(os.Environ(), "RENDERER_TOKEN="+token, "RENDERER_PORT="+strconv.Itoa(workerPort), "RENDER_SLOTS="+strconv.Itoa(slots))
	worker.Stdout = os.Stdout
	worker.Stderr = os.Stderr
	if err = worker.Start(); err != nil {
		return err
	}
	workerDone := make(chan error, 1)
	go func() { workerDone <- worker.Wait() }()
	defer func() { _ = worker.Process.Kill() }()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConnsPerHost = slots + 8
	renderer := &gateway.HTTPRenderer{URL: fmt.Sprintf("http://127.0.0.1:%d", workerPort), Token: token, Client: &http.Client{Transport: transport, Timeout: time.Duration(timeout) * time.Millisecond}}
	signalCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	root, cancelWork := context.WithCancel(context.Background())
	defer cancelWork()
	service := &gateway.Server{Secret: secret, Version: version, TrustedHosts: hosts, Renderer: renderer, Store: store,
		Coordinator: gateway.NewCoordinator(root, slots, pending, time.Duration(timeout)*time.Millisecond),
		TTL:         time.Duration(ttl) * time.Second, CacheTimeout: time.Duration(cacheMS) * time.Millisecond,
		RequestTimeout: time.Duration(timeout) * time.Millisecond, MaxRequests: int64(maxRequests), Logger: logger}
	server := &http.Server{Addr: fmt.Sprintf(":%d", port), Handler: service, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, WriteTimeout: time.Duration(timeout)*time.Millisecond + 5*time.Second, MaxHeaderBytes: 16384}
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.ListenAndServe() }()
	logger.Info("gateway started", "port", port, "render_slots", slots, "pending_limit", pending, "persistent_cache", store != nil)
	var failure error
	workerExited := false
	select {
	case <-signalCtx.Done():
	case err = <-workerDone:
		failure = fmt.Errorf("renderer exited unexpectedly: %v", err)
		workerExited = true
	case err = <-serverDone:
		if !errors.Is(err, http.ErrServerClosed) {
			failure = err
		}
	}
	service.Draining.Store(true)
	logger.Info("draining screenshot requests")
	drainCtx, cancelDrain := context.WithTimeout(context.Background(), 20*time.Second)
	err = server.Shutdown(drainCtx)
	cancelDrain()
	cancelWork()
	if err != nil {
		_ = server.Close()
	}
	if !workerExited {
		_ = worker.Process.Signal(syscall.SIGTERM)
		select {
		case <-workerDone:
		case <-time.After(5 * time.Second):
			_ = worker.Process.Kill()
			<-workerDone
		}
	}
	return failure
}
func main() {
	if err := run(); err != nil {
		slog.Error("gateway stopped", "error", err)
		os.Exit(1)
	}
}
