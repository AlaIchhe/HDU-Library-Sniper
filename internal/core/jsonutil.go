package core

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Get traverses nested map[string]any keys safely, returning nil if any step is missing.
func Get(v any, keys ...string) any {
	cur := v
	for _, k := range keys {
		m, ok := cur.(map[string]any)
		if !ok || m == nil {
			return nil
		}
		cur = m[k]
	}
	return cur
}

func GetString(v any, keys ...string) string {
	return ToString(Get(v, keys...))
}

func GetInt64(v any, keys ...string) int64 {
	return ToInt64(Get(v, keys...))
}

func AsMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func AsSlice(v any) []any {
	if s, ok := v.([]any); ok {
		return s
	}
	return nil
}

// ToString coerces loose JSON scalar values (string, number, bool) to string.
func ToString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		if math.Trunc(x) == x {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(x, 10)
	case int:
		return strconv.Itoa(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

// ToInt64 coerces loose JSON numeric or numeric-string values to int64.
func ToInt64(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case int64:
		return x
	case int:
		return int64(x)
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		if f, err := x.Float64(); err == nil {
			return int64(f)
		}
		return 0
	case string:
		s := strings.TrimSpace(x)
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			return i
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return int64(f)
		}
		return 0
	default:
		return 0
	}
}

func ToBool(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return strings.EqualFold(strings.TrimSpace(x), "true") || x == "1"
	case float64:
		return x != 0
	case int64:
		return x != 0
	case int:
		return x != 0
	default:
		return false
	}
}
