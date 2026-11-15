package hdu

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"hdu-library-sniper/internal/core"
)

func (c *LibraryClient) RoomTypes(ctx context.Context) ([]core.RoomTypeOption, error) {
	body, err := c.requestJSON(ctx, "/Space/Category/list?LAB_JSON=1", http.MethodGet, nil, nil, false)
	if err != nil {
		return nil, err
	}
	var items []any
	for _, key := range []string{"content", "data", "DATA"} {
		if found := findNonEmptyDefaultItems(body[key]); len(found) > 0 {
			items = found
			break
		}
	}
	if len(items) == 0 {
		return nil, LibraryError("房间类型列表为空")
	}

	opts := make([]core.RoomTypeOption, 0, len(items))
	for _, raw := range items {
		m := core.AsMap(raw)
		if m == nil {
			continue
		}
		name := strings.TrimSpace(core.ToString(m["name"]))
		linkURL := core.GetString(m, "link", "url")
		query := extractRoomQuery(linkURL)
		if name == "" || query == "" {
			continue
		}
		id := strings.TrimSpace(core.ToString(m["id"]))
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
	body, err := c.requestJSON(
		ctx,
		"/Seat/Index/searchSeats?"+strings.TrimPrefix(roomQuery, "?")+"&LAB_JSON=1",
		http.MethodGet, nil, nil, false,
	)
	if err != nil {
		return core.BookingRange{}, err
	}
	r := core.AsMap(core.Get(body, "data", "range"))
	if r == nil {
		return core.BookingRange{}, LibraryError("预约时间范围解析失败")
	}
	minDur := core.ToInt64(r["min_duration"])
	if minDur <= 0 {
		minDur = 1
	}
	return core.BookingRange{
		MinBeginTime: core.ToInt64(r["minBeginTime"]),
		MaxEndTime:   core.ToInt64(r["maxEndTime"]),
		MinDuration:  minDur,
		MaxDuration:  core.ToInt64(r["max_duration"]),
	}, nil
}

func (c *LibraryClient) lookupCategory(ctx context.Context, roomQuery string) (category, error) {
	c.mu.Lock()
	cached, ok := c.categories[roomQuery]
	c.mu.Unlock()
	if ok {
		return cached, nil
	}

	body, err := c.requestJSON(
		ctx,
		"/Seat/Index/searchSeats?"+strings.TrimPrefix(roomQuery, "?")+"&LAB_JSON=1",
		http.MethodGet, nil, nil, false,
	)
	if err != nil {
		return category{}, err
	}
	sc := core.AsMap(core.Get(body, "data", "space_category"))
	catID := ""
	contentID := ""
	if sc != nil {
		catID = strings.TrimSpace(core.ToString(sc["category_id"]))
		contentID = strings.TrimSpace(core.ToString(sc["content_id"]))
	}
	if catID == "" {
		return category{}, LibraryError("房间详情解析失败")
	}
	cat := category{categoryID: catID, contentID: contentID}
	c.mu.Lock()
	c.categories[roomQuery] = cat
	c.mu.Unlock()
	return cat, nil
}

func (c *LibraryClient) Floors(ctx context.Context, roomQuery string, lookupTime time.Time, durationHours int64) ([]map[string]any, error) {
	cat, err := c.lookupCategory(ctx, roomQuery)
	if err != nil {
		return nil, err
	}
	form := url.Values{}
	form.Set("beginTime", strconv.FormatInt(lookupTime.Unix(), 10))
	form.Set("duration", strconv.FormatInt(durationHours*3600, 10))
	form.Set("num", "1")
	form.Set("space_category[category_id]", cat.categoryID)
	form.Set("space_category[content_id]", cat.contentID)

	body, err := c.requestJSON(ctx, "/Seat/Index/searchSeats?LAB_JSON=1", http.MethodPost, form, nil, false)
	if err != nil {
		return nil, err
	}
	topChildren := core.AsSlice(core.Get(body, "allContent", "children"))
	if len(topChildren) <= 2 {
		return nil, LibraryError("座位图解析失败")
	}
	rawFloors := core.AsSlice(core.Get(topChildren[2], "children", "children"))
	if rawFloors == nil {
		return nil, LibraryError("座位图解析失败")
	}
	floors := make([]map[string]any, 0, len(rawFloors))
	for _, f := range rawFloors {
		if m := core.AsMap(f); m != nil {
			floors = append(floors, m)
		}
	}
	return floors, nil
}

// FloorOptionFromRaw converts a raw searchSeats floor node into FloorOption.
func FloorOptionFromRaw(raw map[string]any) *core.FloorOption {
	info := core.AsMap(core.Get(raw, "seatMap", "info"))
	if info == nil {
		return nil
	}
	id := core.ToInt64(info["id"])
	if id <= 0 {
		return nil
	}
	name := strings.TrimSpace(core.ToString(info["name"]))
	if name == "" {
		name = "楼层 " + strconv.FormatInt(id, 10)
	}
	pois := core.AsSlice(core.Get(raw, "seatMap", "POIs"))
	titles := make([]string, 0, len(pois))
	for _, p := range pois {
		if m := core.AsMap(p); m != nil {
			if t := strings.TrimSpace(core.ToString(m["title"])); t != "" {
				titles = append(titles, t)
			}
		}
	}
	return &core.FloorOption{
		ID:         id,
		Name:       name,
		SeatCount:  int64(len(titles)),
		SeatTitles: titles,
	}
}

func findNonEmptyDefaultItems(v any) []any {
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			if found := findNonEmptyDefaultItems(item); len(found) > 0 {
				return found
			}
		}
	case map[string]any:
		if items := core.AsSlice(x["defaultItems"]); len(items) > 0 {
			return items
		}
		for _, child := range core.AsSlice(x["children"]) {
			if found := findNonEmptyDefaultItems(child); len(found) > 0 {
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
	parts := strings.Split(q, "&")
	kept := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" && p != "LAB_JSON=1" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "&")
}
