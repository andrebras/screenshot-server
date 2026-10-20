package gateway

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func await(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("condition did not become true")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestConcurrentDuplicatesShareRender(t *testing.T) {
	c := NewCoordinator(context.Background(), 1, 0, time.Second)
	release := make(chan struct{})
	var calls atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := c.Do(context.Background(), "same", func(context.Context) (Result, error) {
				calls.Add(1)
				<-release
				return Result{Image: []byte("same")}, nil
			})
			if e != nil || string(r.Image) != "same" {
				t.Errorf("%+v %v", r, e)
			}
		}()
	}
	await(t, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.jobs["same"] != nil && c.jobs["same"].waiters == 50
	})
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
}
func TestCancelOneWaiterKeepsSharedRender(t *testing.T) {
	c := NewCoordinator(context.Background(), 1, 0, time.Second)
	started := make(chan struct{})
	release := make(chan struct{})
	first := make(chan error, 1)
	second := make(chan error, 1)
	firstCtx, cancel := context.WithCancel(context.Background())
	go func() {
		_, e := c.Do(firstCtx, "a", func(ctx context.Context) (Result, error) {
			close(started)
			select {
			case <-release:
				return Result{}, nil
			case <-ctx.Done():
				return Result{}, ctx.Err()
			}
		})
		first <- e
	}()
	<-started
	go func() {
		_, e := c.Do(context.Background(), "a", func(context.Context) (Result, error) { t.Error("duplicate work ran"); return Result{}, nil })
		second <- e
	}()
	await(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.jobs["a"].waiters == 2 })
	cancel()
	if !errors.Is(<-first, context.Canceled) {
		t.Fatal("caller was not canceled")
	}
	close(release)
	if e := <-second; e != nil {
		t.Fatal("shared work canceled", e)
	}
}
func TestCancelLastWaiterStopsWorkAndAllowsRetry(t *testing.T) {
	c := NewCoordinator(context.Background(), 1, 0, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		_, _ = c.Do(ctx, "a", func(job context.Context) (Result, error) {
			close(started)
			<-job.Done()
			close(stopped)
			return Result{}, job.Err()
		})
	}()
	<-started
	cancel()
	<-stopped
	await(t, func() bool { _, n := c.Occupancy(); return n == 0 })
	if _, e := c.Do(context.Background(), "a", func(context.Context) (Result, error) { return Result{}, nil }); e != nil {
		t.Fatal(e)
	}
}
func TestBoundedAdmissionAndQueuedDeadline(t *testing.T) {
	c := NewCoordinator(context.Background(), 1, 1, 80*time.Millisecond)
	started := make(chan struct{})
	release := make(chan struct{})
	first := make(chan error, 1)
	second := make(chan error, 1)
	go func() {
		_, e := c.Do(context.Background(), "a", func(context.Context) (Result, error) { close(started); <-release; return Result{}, nil })
		first <- e
	}()
	<-started
	var queuedRan atomic.Bool
	go func() {
		_, e := c.Do(context.Background(), "b", func(context.Context) (Result, error) { queuedRan.Store(true); return Result{}, nil })
		second <- e
	}()
	await(t, func() bool { _, n := c.Occupancy(); return n == 2 })
	if _, e := c.Do(context.Background(), "c", nil); !errors.Is(e, ErrBusy) {
		t.Fatal(e)
	}
	if e := <-second; !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal(e)
	}
	if queuedRan.Load() {
		t.Fatal("expired queued job ran")
	}
	close(release)
	<-first
}
