package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"
)

type Renderer interface {
	Render(context.Context, Spec) ([]byte, error)
	Healthy(context.Context) bool
}
type RenderError struct{ Status int }

func (e RenderError) Error() string { return fmt.Sprintf("renderer returned HTTP %d", e.Status) }

type HTTPRenderer struct {
	URL    string
	Token  string
	Client *http.Client
}

func (r *HTTPRenderer) request(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, r.URL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return r.Client.Do(req)
}
func (r *HTTPRenderer) Render(ctx context.Context, spec Spec) ([]byte, error) {
	body, _ := json.Marshal(spec)
	res, err := r.request(ctx, "POST", "/render", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, RenderError{res.StatusCode}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, MaxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxImageBytes || len(data) < 3 || data[0] != 0xff || data[1] != 0xd8 {
		return nil, errors.New("invalid renderer image")
	}
	return data, nil
}
func (r *HTTPRenderer) Healthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	res, err := r.request(ctx, "GET", "/live", nil)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	return res.StatusCode == 200
}

type Server struct {
	Secret         string
	Version        string
	TrustedHosts   map[string]bool
	Renderer       Renderer
	Store          Store
	Coordinator    *Coordinator
	TTL            time.Duration
	CacheTimeout   time.Duration
	RequestTimeout time.Duration
	MaxRequests    int64
	Logger         *slog.Logger
	Draining       atomic.Bool
	active         atomic.Int64
	requests       atomic.Int64
	hits           atomic.Int64
	renders        atomic.Int64
	cacheErrors    atomic.Int64
	busy           atomic.Int64
}

type cachedBody struct {
	io.Reader
	close func() error
}

func (b *cachedBody) Close() error { return b.close() }
func (s *Server) cached(ctx context.Context, key string) (*CachedObject, int, bool) {
	if s.Store == nil {
		return nil, 0, false
	}
	cacheCtx, cancel := context.WithCancel(ctx)
	timer := time.AfterFunc(s.CacheTimeout, cancel)
	object, err := s.Store.Get(cacheCtx, key)
	if err != nil {
		timer.Stop()
		cancel()
		if !errors.Is(err, ErrMiss) {
			s.cacheErrors.Add(1)
			s.Logger.Warn("cache read failed", "error", err)
		}
		return nil, 0, false
	}
	age := max(time.Since(object.Created), 0)
	remaining := int((s.TTL - age).Seconds())
	prefix := make([]byte, 2)
	_, err = io.ReadFull(object.Body, prefix)
	timer.Stop()
	if remaining < 1 || err != nil || prefix[0] != 0xff || prefix[1] != 0xd8 {
		object.Body.Close()
		cancel()
		return nil, 0, false
	}
	original := object.Body
	object.Body = &cachedBody{Reader: io.MultiReader(bytes.NewReader(prefix), original), close: func() error { defer cancel(); return original.Close() }}
	s.hits.Add(1)
	return object, remaining, true
}
func imageHeaders(w http.ResponseWriter, size int64, maxAge int, cache string) {
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age="+strconv.Itoa(maxAge))
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("X-Screenshot-Cache", cache)
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.URL.Path {
	case "/metrics":
		active, admitted := s.Coordinator.Occupancy()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "screenshot_gateway_requests_total %d\nscreenshot_cache_hits_total %d\nscreenshot_render_jobs_total %d\nscreenshot_cache_errors_total %d\nscreenshot_overload_total %d\nscreenshot_render_slots_active %d\nscreenshot_jobs_admitted %d\nscreenshot_http_active %d\n", s.requests.Load(), s.hits.Load(), s.renders.Load(), s.cacheErrors.Load(), s.busy.Load(), active, admitted, s.active.Load())
		return
	case "/live":
		if !s.Renderer.Healthy(r.Context()) {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(200)
		return
	case "/ready", "/healthcheck":
		if s.Draining.Load() || !s.Renderer.Healthy(r.Context()) {
			w.WriteHeader(503)
			return
		}
		w.WriteHeader(200)
		return
	case "/screenshots":
	default:
		w.WriteHeader(404)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(405)
		return
	}
	s.requests.Add(1)
	if s.Draining.Load() {
		w.WriteHeader(503)
		return
	}
	current := s.active.Add(1)
	defer s.active.Add(-1)
	if current > s.MaxRequests {
		s.busy.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(503)
		return
	}
	start := time.Now()
	requestID := r.Header.Get("X-Amzn-Trace-Id")
	if requestID == "" || len(requestID) > 256 {
		id := make([]byte, 16)
		if _, e := rand.Read(id); e == nil {
			requestID = hex.EncodeToString(id)
		}
	}
	var sourceHost, sourcePath string
	status := 200
	cache := "none"
	defer func() {
		s.Logger.Info("screenshot request", "status", status, "cache", cache, "duration_ms", time.Since(start).Milliseconds(), "request_id", requestID, "src_host", sourceHost, "src_path", sourcePath)
	}()
	spec, key, err := Parse(r.URL.RawQuery, s.Secret, s.Version, s.TrustedHosts)
	if err != nil {
		status = 400
		http.Error(w, err.Error(), status)
		return
	}
	source, _ := url.Parse(spec.Src)
	sourceHost, sourcePath = source.Hostname(), source.Path
	ctx, cancel := context.WithTimeout(r.Context(), s.RequestTimeout)
	defer cancel()
	if object, maxAge, ok := s.cached(ctx, key); ok {
		defer object.Body.Close()
		cache = "hit"
		imageHeaders(w, object.Size, maxAge, cache)
		if r.Method != "HEAD" {
			if _, e := io.CopyN(w, object.Body, object.Size); e != nil {
				status = 502
				s.Logger.Warn("cached image transfer failed", "error", e)
			}
		}
		return
	}
	result, err := s.Coordinator.Do(ctx, key, func(jobCtx context.Context) (Result, error) {
		if object, maxAge, ok := s.cached(jobCtx, key); ok {
			data, readErr := io.ReadAll(io.LimitReader(object.Body, MaxImageBytes+1))
			object.Body.Close()
			if readErr == nil && int64(len(data)) == object.Size {
				return Result{Image: data, MaxAge: maxAge, Cache: "hit"}, nil
			}
		}
		s.renders.Add(1)
		image, e := s.Renderer.Render(jobCtx, spec)
		if e != nil {
			return Result{}, e
		}
		if s.Store != nil {
			putCtx, putCancel := context.WithTimeout(jobCtx, s.CacheTimeout)
			e = s.Store.Put(putCtx, key, image)
			putCancel()
			if e != nil {
				s.cacheErrors.Add(1)
				s.Logger.Warn("cache write failed", "error", e)
			}
		}
		return Result{Image: image, MaxAge: int(s.TTL.Seconds()), Cache: "miss"}, nil
	})
	if err != nil {
		switch {
		case errors.Is(err, ErrBusy):
			status = 503
			s.busy.Add(1)
			w.Header().Set("Retry-After", "1")
		case errors.Is(err, context.DeadlineExceeded):
			status = 504
		case errors.Is(err, context.Canceled):
			status = 499
		default:
			status = 502
			var re RenderError
			if errors.As(err, &re) && (re.Status == 400 || re.Status == 503 || re.Status == 504) {
				status = re.Status
			}
		}
		if r.Context().Err() == nil {
			w.WriteHeader(status)
		}
		return
	}
	cache = result.Cache
	imageHeaders(w, int64(len(result.Image)), result.MaxAge, result.Cache)
	if r.Method != "HEAD" {
		_, _ = w.Write(result.Image)
	}
}
