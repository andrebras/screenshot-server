package gateway

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var jpeg = []byte{0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9}

type stored struct {
	data    []byte
	created time.Time
}
type memoryStore struct {
	mu     sync.Mutex
	items  map[string]stored
	broken bool
}

func (m *memoryStore) Get(ctx context.Context, key string) (*CachedObject, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.broken {
		return nil, errors.New("offline")
	}
	v, ok := m.items[key]
	if !ok {
		return nil, ErrMiss
	}
	return &CachedObject{Body: io.NopCloser(bytes.NewReader(v.data)), Size: int64(len(v.data)), Created: v.created}, nil
}
func (m *memoryStore) Put(ctx context.Context, key string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.broken {
		return errors.New("offline")
	}
	m.items[key] = stored{data, time.Now()}
	return nil
}

type fakeRenderer struct {
	calls   atomic.Int32
	render  func(context.Context, Spec) ([]byte, error)
	healthy bool
}

func (f *fakeRenderer) Render(ctx context.Context, s Spec) ([]byte, error) {
	f.calls.Add(1)
	if f.render != nil {
		return f.render(ctx, s)
	}
	return jpeg, nil
}
func (f *fakeRenderer) Healthy(context.Context) bool { return f.healthy }
func service(f *fakeRenderer, store Store) *Server {
	return &Server{Secret: "test-key", Version: "test-v1", Renderer: f, Store: store, Coordinator: NewCoordinator(context.Background(), 1, 0, time.Second), TTL: 24 * time.Hour, CacheTimeout: 20 * time.Millisecond, RequestTimeout: time.Second, MaxRequests: 100, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}
func request(s *Server, raw string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/screenshots?"+raw, nil))
	return w
}
func TestStoredResultBypassesOccupiedRendererAndExpires(t *testing.T) {
	store := &memoryStore{items: map[string]stored{}}
	renderer := &fakeRenderer{healthy: true}
	s := service(renderer, store)
	raw := signed(query("https://example.com/") + "&ts=1")
	if w := request(s, raw); w.Code != 200 || w.Header().Get("X-Screenshot-Cache") != "miss" {
		t.Fatal(w)
	}
	s.Coordinator.slots <- struct{}{}
	s.Coordinator.admitted <- struct{}{}
	if w := request(s, raw); w.Code != 200 || w.Header().Get("X-Screenshot-Cache") != "hit" {
		t.Fatal(w)
	}
	<-s.Coordinator.slots
	<-s.Coordinator.admitted
	if renderer.calls.Load() != 1 {
		t.Fatal("cache hit rendered")
	}
	for k, v := range store.items {
		v.created = time.Now().Add(-25 * time.Hour)
		store.items[k] = v
	}
	if w := request(s, raw); w.Code != 200 || renderer.calls.Load() != 2 {
		t.Fatal(w)
	}
	if w := request(s, signed(query("https://example.com/")+"&ts=2")); w.Code != 200 || renderer.calls.Load() != 3 {
		t.Fatal("version change reused stale image")
	}
}
func TestCacheOutageDoesNotBreakRendering(t *testing.T) {
	s := service(&fakeRenderer{}, &memoryStore{broken: true})
	w := request(s, signed(query("https://example.com/")))
	if w.Code != 200 || s.cacheErrors.Load() == 0 {
		t.Fatal(w)
	}
}
func TestFailuresAreNotCached(t *testing.T) {
	f := &fakeRenderer{render: func(context.Context, Spec) ([]byte, error) { return nil, RenderError{502} }}
	store := &memoryStore{items: map[string]stored{}}
	s := service(f, store)
	for i := 0; i < 2; i++ {
		w := request(s, signed(query("https://example.com/")))
		if w.Code != 502 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w)
		}
	}
	if f.calls.Load() != 2 || len(store.items) != 0 {
		t.Fatal("cached failure")
	}
}
func TestAdmissionHealthMethodsAndSignature(t *testing.T) {
	f := &fakeRenderer{healthy: true}
	s := service(f, nil)
	for _, raw := range []string{query("https://example.com/"), signed(query("https://example.com/") + "&width=1")} {
		if w := request(s, raw); w.Code != 400 || f.calls.Load() != 0 {
			t.Fatal(w)
		}
	}
	s.Coordinator.admitted <- struct{}{}
	if w := request(s, signed(query("https://example.com/"))); w.Code != 503 || w.Header().Get("Retry-After") != "1" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w)
	}
	for _, path := range []string{"/healthcheck", "/ready", "/live"} {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 {
			t.Fatal(w)
		}
	}
	s.Draining.Store(true)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/ready", nil))
	if w.Code != 503 {
		t.Fatal(w)
	}
	if w := request(s, signed(query("https://example.com/"))); w.Code != 503 || s.active.Load() != 0 {
		t.Fatal(w)
	}
	s.Draining.Store(false)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("POST", "/screenshots", nil))
	if w.Code != 405 {
		t.Fatal(w)
	}
}
func TestRequestDeadlineCancelsRenderer(t *testing.T) {
	stopped := make(chan struct{})
	f := &fakeRenderer{render: func(ctx context.Context, _ Spec) ([]byte, error) { <-ctx.Done(); close(stopped); return nil, ctx.Err() }}
	s := service(f, nil)
	s.RequestTimeout = 20 * time.Millisecond
	if w := request(s, signed(query("https://example.com/"))); w.Code != 504 {
		t.Fatal(w)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("orphaned render")
	}
}
func TestHTTPRendererAuthenticatesAndBoundsOutput(t *testing.T) {
	var mode atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer internal-token" {
			t.Error("missing worker authentication")
		}
		if r.URL.Path == "/live" {
			return
		}
		switch mode.Load() {
		case 1:
			w.WriteHeader(400)
		case 2:
			_, _ = w.Write([]byte("not jpeg"))
		default:
			_, _ = w.Write(jpeg)
		}
	}))
	defer worker.Close()
	f := &HTTPRenderer{URL: worker.URL, Token: "internal-token", Client: worker.Client()}
	if !f.Healthy(context.Background()) {
		t.Fatal("health failed")
	}
	if data, e := f.Render(context.Background(), Spec{}); e != nil || string(data) != string(jpeg) {
		t.Fatal(e)
	}
	mode.Store(1)
	if _, e := f.Render(context.Background(), Spec{}); e == nil {
		t.Fatal("accepted worker failure")
	}
	mode.Store(2)
	if _, e := f.Render(context.Background(), Spec{}); e == nil {
		t.Fatal("accepted corrupt output")
	}
}
func TestCacheHitMaxAgeDoesNotExtendFreshness(t *testing.T) {
	store := &memoryStore{items: map[string]stored{}}
	s := service(&fakeRenderer{}, store)
	raw := signed(query("https://example.com/"))
	_, key, _ := Parse(raw, "test-key", "test-v1", nil)
	store.items[key] = stored{jpeg, time.Now().Add(-23 * time.Hour)}
	w := request(s, raw)
	if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Cache-Control"), "public, max-age=35") {
		t.Fatal(w.Header())
	}
}

type trackedBody struct {
	io.Reader
	reads  int
	closed bool
}

func (b *trackedBody) Read(p []byte) (int, error) {
	n, e := b.Reader.Read(p)
	b.reads += n
	return n, e
}
func (b *trackedBody) Close() error { b.closed = true; return nil }

type streamStore struct {
	body    *trackedBody
	ctx     context.Context
	stalled bool
}

func (s *streamStore) Get(ctx context.Context, _ string) (*CachedObject, error) {
	s.ctx = ctx
	if s.stalled {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return &CachedObject{Body: s.body, Size: MaxImageBytes, Created: time.Now()}, nil
}
func (s *streamStore) Put(context.Context, string, []byte) error { return nil }
func TestCacheHitStreamsWithoutBufferingAndClosesOnHead(t *testing.T) {
	body := &trackedBody{Reader: io.MultiReader(bytes.NewReader(jpeg), io.LimitReader(zeroReader{}, MaxImageBytes-int64(len(jpeg))))}
	store := &streamStore{body: body}
	s := service(&fakeRenderer{}, store)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("HEAD", "/screenshots?"+signed(query("https://example.com/")), nil))
	if w.Code != 200 || body.reads != 2 || !body.closed || w.Body.Len() != 0 {
		t.Fatalf("status=%d reads=%d closed=%v", w.Code, body.reads, body.closed)
	}
	if !errors.Is(store.ctx.Err(), context.Canceled) {
		t.Fatal("storage context leaked")
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { clear(p); return len(p), nil }
func TestStorageTimeoutFallsBackWithinBoundedBudget(t *testing.T) {
	f := &fakeRenderer{}
	s := service(f, &streamStore{stalled: true})
	started := time.Now()
	w := request(s, signed(query("https://example.com/")))
	if w.Code != 200 || f.calls.Load() != 1 {
		t.Fatal(w)
	}
	if time.Since(started) > 500*time.Millisecond {
		t.Fatal("cache timeout stalled rendering")
	}
}
