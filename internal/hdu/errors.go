package hdu

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

type ErrorKind int

const (
	KindAuthExpired ErrorKind = iota + 1
	KindTimeout
	KindHTTP
	KindNetwork
	KindLibrary
	KindBanned
	KindThrottled
	KindFlowError
	KindSeatUnavailable
	KindDuplicate
	KindAlreadyCheckedIn
	KindNotPending
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

// LibraryError classifies HDU Chinese error messages once at the protocol boundary into semantic ErrorKinds.
func LibraryError(msg string) error {
	return &Error{Kind: classifyLibraryMessage(msg), Message: msg}
}

func classifyLibraryMessage(msg string) ErrorKind {
	switch {
	case strings.Contains(msg, "请求过于频繁") || strings.Contains(msg, "非手机端请求过于频繁"):
		return KindBanned
	case strings.Contains(msg, "请求太频繁了"):
		return KindThrottled
	case strings.Contains(msg, "订座流程异常"):
		return KindFlowError
	case strings.Contains(msg, "座位无法预约") ||
		strings.Contains(msg, "已经被其他人锁定") ||
		strings.Contains(msg, "座位不可用") ||
		strings.Contains(msg, "已被占用"):
		return KindSeatUnavailable
	case strings.Contains(msg, "已有预约") || strings.Contains(msg, "请勿重复") || strings.Contains(msg, "重复预约"):
		return KindDuplicate
	case strings.Contains(msg, "已签到") || strings.Contains(msg, "重复签到"):
		return KindAlreadyCheckedIn
	case strings.Contains(msg, "非待签到"):
		return KindNotPending
	default:
		return KindLibrary
	}
}

func hasKind(err error, kind ErrorKind) bool {
	var e *Error
	return errors.As(err, &e) && e.Kind == kind
}

func IsAuthExpired(err error) bool      { return hasKind(err, KindAuthExpired) }
func IsRequestTimeout(err error) bool   { return hasKind(err, KindTimeout) }
func IsBanned(err error) bool           { return hasKind(err, KindBanned) }
func IsThrottled(err error) bool        { return hasKind(err, KindThrottled) }
func IsFlowError(err error) bool        { return hasKind(err, KindFlowError) }
func IsSeatUnavailable(err error) bool  { return hasKind(err, KindSeatUnavailable) }
func IsDuplicate(err error) bool        { return hasKind(err, KindDuplicate) }
func IsAlreadyCheckedIn(err error) bool { return hasKind(err, KindAlreadyCheckedIn) }
func IsNotPending(err error) bool       { return hasKind(err, KindNotPending) }

func HTTPStatus(err error) int {
	var e *Error
	if errors.As(err, &e) && e.Kind == KindHTTP {
		return e.Status
	}
	return 0
}

func IsSeatQueryBlocked(err error) bool {
	return HTTPStatus(err) == 404 || IsRequestTimeout(err)
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
