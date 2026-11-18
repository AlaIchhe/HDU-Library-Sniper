// Package events provides an in-process pub/sub bus shared by SSE handlers and desktop IPC bridges.
package events

import (
	"encoding/json"
	"sync"
)

const (
	subscriberBuffer = 64

	TopicQrStatus = "qr_status"
	TopicAppEvent = "app_event"
)

var closedDoneChan = func() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}()

// Message represents a single serialized state-change event ready for SSE or IPC delivery.
type Message struct {
	Name    string
	Payload any
	RawJSON []byte
}

// Bus fans out backend domain events to active SSE streams and desktop event bridges without blocking producers.
type Bus struct {
	mu        sync.RWMutex
	nextID    uint64
	subs      map[uint64]chan Message
	listeners map[uint64]func(Message)
	done      chan struct{}
	closeOnce sync.Once
}

func NewBus() *Bus {
	return &Bus{
		subs:      make(map[uint64]chan Message),
		listeners: make(map[uint64]func(Message)),
		done:      make(chan struct{}),
	}
}

// Close signals all active stream subscribers to exit cleanly during shutdown.
func (b *Bus) Close() {
	if b == nil {
		return
	}
	b.closeOnce.Do(func() {
		close(b.done)
	})
}

// Done returns a channel that is closed when the bus shuts down.
func (b *Bus) Done() <-chan struct{} {
	if b == nil {
		return closedDoneChan
	}
	return b.done
}

// Publish encodes payload once and delivers the event non-blockingly to all subscribers and listeners.
func (b *Bus) Publish(name string, payload any) {
	if b == nil {
		return
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	msg := Message{
		Name:    name,
		Payload: payload,
		RawJSON: raw,
	}

	b.mu.RLock()
	subs := make([]chan Message, 0, len(b.subs))
	for _, ch := range b.subs {
		subs = append(subs, ch)
	}
	listeners := make([]func(Message), 0, len(b.listeners))
	for _, fn := range b.listeners {
		listeners = append(listeners, fn)
	}
	b.mu.RUnlock()

	for _, ch := range subs {
		select {
		case ch <- msg:
		default:
			// Drop oldest buffered event when slow subscriber lags so producers never stall.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- msg:
			default:
			}
		}
	}
	for _, fn := range listeners {
		fn(msg)
	}
}

// Subscribe returns a buffered event stream channel and an idempotent unsubscribe callback.
func (b *Bus) Subscribe() (<-chan Message, func()) {
	ch := make(chan Message, subscriberBuffer)
	b.mu.Lock()
	b.nextID++
	id := b.nextID
	b.subs[id] = ch
	b.mu.Unlock()

	var once sync.Once
	return ch, func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.subs, id)
			b.mu.Unlock()
		})
	}
}

// OnPublish registers a synchronous listener invoked whenever an event is published.
func (b *Bus) OnPublish(fn func(Message)) func() {
	if b == nil || fn == nil {
		return func() {}
	}
	b.mu.Lock()
	b.nextID++
	id := b.nextID
	b.listeners[id] = fn
	b.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			delete(b.listeners, id)
			b.mu.Unlock()
		})
	}
}
