package hdu

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"hdu-library-sniper/internal/core"
)

type categoryItem struct {
	ID   FlexString `json:"id"`
	Name FlexString `json:"name"`
	Link *struct {
		URL FlexString `json:"url"`
	} `json:"link"`
}

type categoryTreeNode struct {
	DefaultItems []categoryItem    `json:"defaultItems"`
	Children     []json.RawMessage `json:"children"`
}

type categoryListEnvelope struct {
	Content json.RawMessage `json:"content"`
	Data    json.RawMessage `json:"data"`
	DATA    json.RawMessage `json:"DATA"`
}

type roomMetaEnvelope struct {
	Data *struct {
		SpaceCategory *struct {
			CategoryID FlexString `json:"category_id"`
			ContentID  FlexString `json:"content_id"`
		} `json:"space_category"`
		Range *struct {
			MinBeginTime FlexInt64 `json:"minBeginTime"`
			MaxEndTime   FlexInt64 `json:"maxEndTime"`
			MinDuration  FlexInt64 `json:"min_duration"`
			MaxDuration  FlexInt64 `json:"max_duration"`
		} `json:"range"`
	} `json:"data"`
}

type searchSeatsEnvelope struct {
	Code    FlexString `json:"CODE"`
	Message FlexString `json:"MESSAGE"`
	Data    *struct {
		Msg FlexString `json:"msg"`
	} `json:"DATA"`
	AllContent *struct {
		Children []struct {
			Children *struct {
				Children []FloorNode `json:"children"`
			} `json:"children"`
		} `json:"children"`
	} `json:"allContent"`
}

func (c *LibraryClient) RoomTypes(ctx context.Context) ([]core.RoomTypeOption, error) {
	var env categoryListEnvelope
	if err := c.requestInto(ctx, "/Space/Category/list?LAB_JSON=1", http.MethodGet, nil, nil, false, &env); err != nil {
		return nil, err
	}
	var items []categoryItem
	for _, raw := range []json.RawMessage{env.Content, env.Data, env.DATA} {
		if found := findCategoryItems(raw); len(found) > 0 {
			items = found
			break
		}
	}
	if len(items) == 0 {
		return nil, LibraryError("房间类型列表为空")
	}

	opts := make([]core.RoomTypeOption, 0, len(items))
	for _, m := range items {
		name := strings.TrimSpace(m.Name.String())
		linkURL := ""
		if m.Link != nil {
			linkURL = m.Link.URL.String()
		}
		query := extractRoomQuery(linkURL)
		if name == "" || query == "" {
			continue
		}
		id := strings.TrimSpace(m.ID.String())
		if id == "" {
			id = query
		}
		opts = append(opts, core.RoomTypeOption{
			ID:    id,
			Name:  name,
			Query: query,
		})
	}
	return opts, nil
}

func (c *LibraryClient) BookingRange(ctx context.Context, roomQuery string) (core.BookingRange, error) {
	meta, err := c.loadRoomMeta(ctx, roomQuery)
	if err != nil {
		return core.BookingRange{}, err
	}
	if !meta.hasRange {
		return core.BookingRange{}, LibraryError("预约时间范围解析失败")
	}
	return meta.rng, nil
}

// ClearRoomMeta clears cached room category and range metadata (for specific queries, or all when omitted).
func (c *LibraryClient) ClearRoomMeta(roomQueries ...string) {
	c.mu.Lock()
	if len(roomQueries) == 0 {
		c.roomMeta = make(map[string]roomMetaEntry)
	} else {
		for _, q := range roomQueries {
			delete(c.roomMeta, strings.TrimPrefix(strings.TrimSpace(q), "?"))
		}
	}
	c.mu.Unlock()
}

func (c *LibraryClient) loadRoomMeta(ctx context.Context, roomQuery string) (roomMetaEntry, error) {
	key := strings.TrimPrefix(strings.TrimSpace(roomQuery), "?")
	c.mu.Lock()
	cached, ok := c.roomMeta[key]
	c.mu.Unlock()
	if ok {
		return cached, nil
	}

	var env roomMetaEnvelope
	if err := c.requestInto(
		ctx,
		"/Seat/Index/searchSeats?"+key+"&LAB_JSON=1",
		http.MethodGet, nil, nil, false, &env,
	); err != nil {
		return roomMetaEntry{}, err
	}
	catID := ""
	contentID := ""
	if env.Data != nil && env.Data.SpaceCategory != nil {
		catID = strings.TrimSpace(env.Data.SpaceCategory.CategoryID.String())
		contentID = strings.TrimSpace(env.Data.SpaceCategory.ContentID.String())
	}
	if catID == "" {
		return roomMetaEntry{}, LibraryError("房间详情解析失败")
	}
	entry := roomMetaEntry{
		cat: category{categoryID: catID, contentID: contentID},
	}
	if env.Data != nil && env.Data.Range != nil {
		r := env.Data.Range
		minDur := int64(r.MinDuration)
		if minDur <= 0 {
			minDur = 1
		}
		entry.hasRange = true
		entry.rng = core.BookingRange{
			MinBeginTime: int64(r.MinBeginTime),
			MaxEndTime:   int64(r.MaxEndTime),
			MinDuration:  minDur,
			MaxDuration:  int64(r.MaxDuration),
		}
	}
	c.mu.Lock()
	c.roomMeta[key] = entry
	c.mu.Unlock()
	return entry, nil
}

func (c *LibraryClient) Floors(ctx context.Context, roomQuery string, lookupTime time.Time, durationHours int64) ([]FloorNode, error) {
	meta, err := c.loadRoomMeta(ctx, roomQuery)
	if err != nil {
		return nil, err
	}
	cat := meta.cat
	form := url.Values{}
	form.Set("beginTime", strconv.FormatInt(lookupTime.Unix(), 10))
	form.Set("duration", strconv.FormatInt(durationHours*3600, 10))
	form.Set("num", "1")
	form.Set("space_category[category_id]", cat.categoryID)
	form.Set("space_category[content_id]", cat.contentID)

	var env searchSeatsEnvelope
	if err := c.requestInto(ctx, "/Seat/Index/searchSeats?LAB_JSON=1", http.MethodPost, form, nil, false, &env); err != nil {
		return nil, err
	}
	errMsg := func() string {
		if env.Data != nil && strings.TrimSpace(env.Data.Msg.String()) != "" {
			return strings.TrimSpace(env.Data.Msg.String())
		}
		if m := strings.TrimSpace(env.Message.String()); m != "" && !strings.EqualFold(m, "ok") && !strings.EqualFold(m, "success") {
			return m
		}
		return "座位图解析失败"
	}
	if code := strings.TrimSpace(env.Code.String()); code != "" && !strings.EqualFold(code, "ok") {
		return nil, LibraryError(errMsg())
	}
	if env.AllContent == nil || len(env.AllContent.Children) <= 2 ||
		env.AllContent.Children[2].Children == nil ||
		env.AllContent.Children[2].Children.Children == nil {
		return nil, LibraryError(errMsg())
	}
	return env.AllContent.Children[2].Children.Children, nil
}

// FloorOptionFromRaw converts a typed FloorNode into core.FloorOption.
func FloorOptionFromRaw(raw FloorNode) *core.FloorOption {
	if raw.SeatMap == nil || raw.SeatMap.Info == nil {
		return nil
	}
	info := raw.SeatMap.Info
	id := int64(info.ID)
	if id <= 0 {
		return nil
	}
	name := firstNonEmpty(raw.RoomName.String(), info.Title.String(), info.Name.String())
	if name == "" {
		name = "楼层 " + strconv.FormatInt(id, 10)
	}
	titles := make([]string, 0, len(raw.SeatMap.POIs))
	for _, p := range raw.SeatMap.POIs {
		if t := strings.TrimSpace(p.Title.String()); t != "" {
			titles = append(titles, t)
		}
	}
	slices.Sort(titles)
	titles = slices.Compact(titles)
	return &core.FloorOption{
		ID:         id,
		Name:       name,
		SeatCount:  int64(len(titles)),
		SeatTitles: titles,
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if t := strings.TrimSpace(v); t != "" {
			return t
		}
	}
	return ""
}

func findCategoryItems(raw json.RawMessage) []categoryItem {
	if len(raw) == 0 {
		return nil
	}
	var arr []json.RawMessage
	if json.Unmarshal(raw, &arr) == nil {
		for _, item := range arr {
			if found := findCategoryItems(item); len(found) > 0 {
				return found
			}
		}
		return nil
	}
	var node categoryTreeNode
	if json.Unmarshal(raw, &node) == nil {
		if len(node.DefaultItems) > 0 {
			return node.DefaultItems
		}
		for _, child := range node.Children {
			if found := findCategoryItems(child); len(found) > 0 {
				return found
			}
		}
	}
	return nil
}

func extractRoomQuery(linkURL string) string {
	idx := strings.IndexByte(linkURL, '?')
	if idx < 0 {
		return ""
	}
	q := linkURL[idx+1:]
	if unescaped, err := url.PathUnescape(q); err == nil {
		q = unescaped
	}
	parts := strings.Split(q, "&")
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" && p != "LAB_JSON=1" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "&")
}
