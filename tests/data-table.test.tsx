import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableHoverActions,
  DataTableRevealCell,
  DataTableRow,
} from "../src/web/components/data-table";

describe("DataTable layout and page unification", () => {
  test("shares grid columns across header and rows without horizontal scroll", () => {
    const columns = "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto]";
    const html = renderToStaticMarkup(
      <DataTable columns={columns} isEmpty={false} empty={<div>empty</div>}>
        <DataTableHeader>
          <span>方案</span>
          <span>时间</span>
          <span className="text-right">操作</span>
        </DataTableHeader>
        <DataTableBody>
          <DataTableRow value="row-1" index={0} active>
            <DataTableRevealCell primary={<span>主楼自习室</span>} reveal={<span>座位 308</span>} />
            <span>08:00</span>
            <DataTableHoverActions>
              <button type="button">编辑</button>
            </DataTableHoverActions>
          </DataTableRow>
        </DataTableBody>
      </DataTable>,
    );

    expect(html).toContain(columns);
    expect(html).toContain("overflow-hidden");
    expect(html).not.toContain("overflow-x-auto");
    expect(html).toContain('data-value="row-1"');
    expect(html).toContain('data-highlight="true"');
  });

  test("renders empty fallback instead of table rows when empty", () => {
    const html = renderToStaticMarkup(
      <DataTable columns="sm:grid-cols-2" isEmpty empty={<div>暂无内容</div>}>
        <DataTableHeader>
          <span>标题</span>
          <span>状态</span>
        </DataTableHeader>
        <DataTableBody>
          <DataTableRow value="row-1" index={0}>
            <span>should not render</span>
            <span>idle</span>
          </DataTableRow>
        </DataTableBody>
      </DataTable>,
    );

    expect(html).toContain("暂无内容");
    expect(html).not.toContain("should not render");
  });

  test("unifies plans and bookings pages using Animate UI highlight without small gray text", () => {
    const plansPage = readFileSync("src/web/components/plans-page.tsx", "utf8");
    const bookingsPage = readFileSync("src/web/components/bookings-page.tsx", "utf8");
    const dataTable = readFileSync("src/web/components/data-table.tsx", "utf8");
    const pageLayout = readFileSync("src/web/components/page-layout.tsx", "utf8");

    expect(pageLayout).not.toContain("function Panel");
    expect(dataTable).toContain("ui/highlight");
    expect(plansPage).toContain("<DataTable");
    expect(bookingsPage).toContain("<DataTable");
    expect(plansPage).not.toContain("我的计划");
    expect(bookingsPage).not.toContain("有效预约");
    expect(plansPage).not.toContain("hidden lg:table-cell");
    expect(plansPage).not.toContain("text-muted-foreground");
    expect(bookingsPage).not.toContain("text-muted-foreground");
  });
});
