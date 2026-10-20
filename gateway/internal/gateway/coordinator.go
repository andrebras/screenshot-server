package gateway

import (
	"context"
	"errors"
	"sync"
	"time"
)

var ErrBusy = errors.New("render capacity exhausted")

type Result struct {
	Image  []byte
	MaxAge int
	Cache  string
}
type flight struct {
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	waiters int
	result  Result
	err     error
}
type Coordinator struct {
	mu       sync.Mutex
	jobs     map[string]*flight
	admitted chan struct{}
	slots    chan struct{}
	deadline time.Duration
	root     context.Context
}

func NewCoordinator(root context.Context, slots, pending int, deadline time.Duration) *Coordinator {
	return &Coordinator{jobs: map[string]*flight{}, admitted: make(chan struct{}, slots+pending), slots: make(chan struct{}, slots), deadline: deadline, root: root}
}
func (c *Coordinator) Do(ctx context.Context, key string, work func(context.Context) (Result, error)) (Result, error) {
	c.mu.Lock()
	f := c.jobs[key]
	if f == nil {
		select {
		case c.admitted <- struct{}{}:
		default:
			c.mu.Unlock()
			return Result{}, ErrBusy
		}
		jobCtx, cancel := context.WithTimeout(c.root, c.deadline)
		f = &flight{ctx: jobCtx, cancel: cancel, done: make(chan struct{})}
		c.jobs[key] = f
		go c.run(key, f, work)
	}
	f.waiters++
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		f.waiters--
		if f.waiters == 0 {
			f.cancel()
			if c.jobs[key] == f {
				delete(c.jobs, key)
			}
		}
	}()
	select {
	case <-ctx.Done():
		return Result{}, ctx.Err()
	case <-f.done:
		return f.result, f.err
	}
}
func (c *Coordinator) run(key string, f *flight, work func(context.Context) (Result, error)) {
	defer func() {
		f.cancel()
		c.mu.Lock()
		if c.jobs[key] == f {
			delete(c.jobs, key)
		}
		<-c.admitted
		close(f.done)
		c.mu.Unlock()
	}()
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	case <-f.ctx.Done():
		f.err = f.ctx.Err()
		return
	}
	if f.ctx.Err() != nil {
		f.err = f.ctx.Err()
		return
	}
	f.result, f.err = work(f.ctx)
}
func (c *Coordinator) Occupancy() (int, int) { return len(c.slots), len(c.admitted) }
