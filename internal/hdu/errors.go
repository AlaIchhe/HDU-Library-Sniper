package hdu

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
)

type ErrorKind int

const (
	KindAuthExpired ErrorKind = iota + 1
	KindTimeout
	KindHTTP
	KindNetwork
	KindLibrary
)

// Error represents structured HDU library API failures used by booking and scheduler retry logic.
type Error struct {
	Kind    ErrorKind
	Status  int
	Message string
	Cause   error
}

func (e *Error) Error() string {
	return e.Message
}

func (e *Error) Unwrap() error {
	return e.Cause
}

func AuthExpired(msg string) error {
	return &Error{Kind: KindAuthExpired, Message: msg}
}

func RequestTimeout(cause error) error {
	return &Error{Kind: KindTimeout, Message: "请求超时，请检查网络连接", Cause: cause}
}

func HTTPError(status int) error {
	return &Error{Kind: KindHTTP, Status: status, Message: fmt.Sprintf("馆方服务返回 HTTP %d", status)}
}

func NetworkError(cause error) error {
	return &Error{Kind: KindNetwork, Message: fmt.Sprintf("网络请求失败: %v", cause), Cause: cause}
}

func LibraryError(msg string) error {
	return &Error{Kind: KindLibrary, Message: msg}
}

func IsAuthExpired(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Kind == KindAuthExpired
}

func IsRequestTimeout(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Kind == KindTimeout
}

func HTTPStatus(err error) int {
	var e *Error
	if errors.As(err, &e) && e.Kind == KindHTTP {
		return e.Status
	}
	return 0
}

func IsRetryableSyncError(err error) bool {
	if IsRequestTimeout(err) {
		return true
	}
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	if e.Kind == KindNetwork {
		return true
	}
	if e.Kind == KindHTTP {
		return e.Status == 404 || e.Status == 429 || (e.Status >= 500 && e.Status <= 599)
	}
	return false
}

func classifyTransportError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return RequestTimeout(err)
	}
	var ue *url.Error
	if errors.As(err, &ue) && ue.Timeout() {
		return RequestTimeout(err)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return RequestTimeout(err)
	}
	return NetworkError(err)
}
