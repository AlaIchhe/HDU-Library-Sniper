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

func TestBusSubscribeFiltersTopics(t *testing.T) {
	bus := NewBus()
	defer bus.Close()

	appOnly, unsubApp := bus.Subscribe(TopicAppEvent)
	defer unsubApp()
	qrOnly, unsubQr := bus.Subscribe(TopicQrStatus)
	defer unsubQr()
	all, unsubAll := bus.Subscribe()
	defer unsubAll()

	bus.Publish(TopicAppEvent, "app")
	bus.Publish(TopicQrStatus, "qr")

	// Each filtered subscriber sees exactly its own topic.
	if got := <-appOnly; got.Name != TopicAppEvent {
		t.Fatalf("app subscriber got %q", got.Name)
	}
	if got := <-qrOnly; got.Name != TopicQrStatus {
		t.Fatalf("qr subscriber got %q", got.Name)
	}
	select {
	case msg := <-appOnly:
		t.Fatalf("app subscriber must not receive %q", msg.Name)
	default:
	}
	select {
	case msg := <-qrOnly:
		t.Fatalf("qr subscriber must not receive %q", msg.Name)
	default:
	}

	// An unrestricted subscriber still receives every topic.
	seen := map[string]bool{}
	for range 2 {
		seen[(<-all).Name] = true
	}
	if !seen[TopicAppEvent] || !seen[TopicQrStatus] {
		t.Fatalf("unrestricted subscriber saw %v", seen)
	}
}

func TestBusSubscribeFiltersUnknownTopic(t *testing.T) {
	bus := NewBus()
	defer bus.Close()

	ch, unsub := bus.Subscribe("no_such_topic")
	defer unsub()

	bus.Publish(TopicAppEvent, "app")
	bus.Publish("no_such_topic", "hello")

	select {
	case msg := <-ch:
		if msg.Name != "no_such_topic" {
			t.Fatalf("got %q, want only the subscribed topic", msg.Name)
		}
	default:
		t.Fatal("expected the subscribed topic to arrive")
	}
	select {
	case msg := <-ch:
		t.Fatalf("unexpected extra message %q", msg.Name)
	default:
	}
}
