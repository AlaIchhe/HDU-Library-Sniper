package events

import (
	"encoding/json"
	"testing"
)

func TestBusSubscribeAndOnPublish(t *testing.T) {
	bus := NewBus()
	ch, unsub := bus.Subscribe()

	var listenerGot []Message
	unlisten := bus.OnPublish(func(m Message) {
		listenerGot = append(listenerGot, m)
	})

	bus.Publish(TopicAppEvent, map[string]string{"kind": "session"})

	select {
	case msg := <-ch:
		if msg.Name != TopicAppEvent {
			t.Fatalf("unexpected topic: %q", msg.Name)
		}
		var body map[string]string
		if err := json.Unmarshal(msg.RawJSON, &body); err != nil || body["kind"] != "session" {
			t.Fatalf("unexpected raw json %q: %v", msg.RawJSON, err)
		}
	default:
		t.Fatal("expected message on subscriber channel")
	}

	if len(listenerGot) != 1 || listenerGot[0].Name != TopicAppEvent {
		t.Fatalf("unexpected listener messages: %+v", listenerGot)
	}

	// Unsubscribe callbacks must be idempotent and stop further deliveries.
	unsub()
	unsub()
	unlisten()
	unlisten()

	bus.Publish(TopicQrStatus, map[string]string{"uuid": "u1"})
	select {
	case msg := <-ch:
		t.Fatalf("expected no message after unsubscribe, got %+v", msg)
	default:
	}
	if len(listenerGot) != 1 {
		t.Fatalf("expected listener to stop after unlisten, got %d", len(listenerGot))
	}
}

func TestBusDropsOldestWhenSubscriberLags(t *testing.T) {
	bus := NewBus()
	ch, unsub := bus.Subscribe()
	defer unsub()

	total := subscriberBuffer + 5
	for i := range total {
		bus.Publish(TopicAppEvent, i)
	}

	if got := len(ch); got != subscriberBuffer {
		t.Fatalf("buffered len = %d, want %d", got, subscriberBuffer)
	}
	first := <-ch
	if first.Payload.(int) != 5 {
		t.Fatalf("expected oldest dropped so first buffered is 5, got %v", first.Payload)
	}
}

func TestBusCloseAndNilSafety(t *testing.T) {
	var nilBus *Bus
	nilBus.Publish(TopicAppEvent, "x")
	nilBus.Close()
	select {
	case <-nilBus.Done():
	default:
		t.Fatal("nil Bus.Done() should already be closed")
	}
	un := nilBus.OnPublish(nil)
	un()

	bus := NewBus()
	select {
	case <-bus.Done():
		t.Fatal("fresh bus Done() should not be closed")
	default:
	}
	bus.Close()
	bus.Close()
	select {
	case <-bus.Done():
	default:
		t.Fatal("closed bus Done() must be closed")
	}
}
