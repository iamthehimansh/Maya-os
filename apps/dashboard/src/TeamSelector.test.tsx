import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenTeam, Team } from "./orchestratorApi";
import { PAGE_SIZE, TeamSelector } from "./TeamSelector";

afterEach(cleanup);

const team = (over: Partial<Team> & { id: string; name: string }): Team => ({
  topology: "star",
  channelId: `maya/team/${over.id}`,
  tokenBudget: null,
  tokensUsed: 0,
  state: "active",
  createdAt: "2026-07-11T00:00:00.000Z",
  inFlight: 0,
  ...over,
});

const liveTeam = (id: string, name: string): Team => team({ id, name, state: "active", live: true });
const doneTeam = (id: string, name: string): Team => team({ id, name, state: "closed", live: false });

/** n finished teams — the real shape that made the flat <select> unusable. */
const many = (n: number, prefix = "finished"): Team[] =>
  Array.from({ length: n }, (_, i) => doneTeam(`${prefix}${i}`, `${prefix}-${i}`));

/** Open the panel and hand back its rows. */
function openPanel(): HTMLElement[] {
  fireEvent.click(screen.getByRole("combobox"));
  return screen.getAllByRole("option");
}

const rowText = (): string[] => screen.getAllByRole("option").map((r) => r.textContent ?? "");
const searchBox = (): HTMLElement => screen.getByLabelText("Search teams");

describe("TeamSelector", () => {
  it("keeps + New chat pinned first and renders live teams above finished ones", () => {
    render(
      <TeamSelector
        teams={[doneTeam("d1", "old-team"), liveTeam("l1", "alpha"), doneTeam("d2", "older-team"), liveTeam("l2", "beta")]}
        openTeam={null}
        onSelect={vi.fn()}
      />,
    );
    const rows = openPanel();
    const text = rows.map((r) => r.textContent ?? "");
    expect(text[0]).toContain("New chat");
    // Live teams take the slots right after the pinned row; finished ones follow.
    expect(text[1]).toContain("alpha");
    expect(text[2]).toContain("beta");
    expect(text[3]).toContain("old-team");
    expect(text[4]).toContain("older-team");
    expect(text[3]).toContain("finished");
    expect(text[1]).not.toContain("finished");
  });

  it("marks the currently open team with a check", () => {
    const open: OpenTeam = { id: "l1", channelId: "maya/team/l1", name: "alpha", live: true };
    render(<TeamSelector teams={[liveTeam("l1", "alpha"), liveTeam("l2", "beta")]} openTeam={open} onSelect={vi.fn()} />);
    openPanel();
    const text = rowText();
    expect(text.find((t) => t.includes("alpha"))).toContain("✓");
    expect(text.find((t) => t.includes("beta"))).not.toContain("✓");
  });

  it("search filters live and finished teams instantly", () => {
    render(
      <TeamSelector
        teams={[liveTeam("l1", "alpha-ui"), liveTeam("l2", "beta"), doneTeam("d1", "gamma-ui"), doneTeam("d2", "delta")]}
        openTeam={null}
        onSelect={vi.fn()}
      />,
    );
    openPanel();
    fireEvent.change(searchBox(), { target: { value: "ui" } });

    const text = rowText();
    expect(text.some((t) => t.includes("alpha-ui"))).toBe(true);
    expect(text.some((t) => t.includes("gamma-ui"))).toBe(true);
    expect(text.some((t) => t.includes("beta"))).toBe(false);
    expect(text.some((t) => t.includes("delta"))).toBe(false);
    expect(text[0]).toContain("New chat"); // the front door is never filtered away
  });

  it("says so when nothing matches the search", () => {
    render(<TeamSelector teams={[liveTeam("l1", "alpha")]} openTeam={null} onSelect={vi.fn()} />);
    openPanel();
    fireEvent.change(searchBox(), { target: { value: "zzz" } });
    expect(screen.getByText(/No team matches/)).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(1); // just + New chat
  });

  it("does not render every row of a long list — finished teams are paged", () => {
    render(<TeamSelector teams={[liveTeam("l1", "alpha"), ...many(29)]} openTeam={null} onSelect={vi.fn()} />);
    const rows = openPanel();
    // 1 pinned + 1 live + PAGE_SIZE finished — NOT 1 + 1 + 29.
    expect(rows).toHaveLength(2 + PAGE_SIZE);
    expect(screen.queryByText("finished-20")).toBeNull();
    expect(screen.getByText("finished-0")).toBeTruthy();
  });

  it("Next/Prev move through the finished pages", () => {
    render(<TeamSelector teams={many(29)} openTeam={null} onSelect={vi.fn()} />);
    openPanel();
    expect(screen.getByText(/Finished 1–8 of 29/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Prev/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText("finished-8")).toBeTruthy();
    expect(screen.queryByText("finished-0")).toBeNull();
    expect(screen.getByText(/Finished 9–16 of 29/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Prev/ }));
    expect(screen.getByText("finished-0")).toBeTruthy();
    expect(screen.queryByText("finished-8")).toBeNull();
  });

  it("pages through SEARCH MATCHES, and a new query resets to page 1", () => {
    // 12 matches for "hit" + 12 that never match: paging must bound the matches.
    render(<TeamSelector teams={[...many(12, "hit"), ...many(12, "miss")]} openTeam={null} onSelect={vi.fn()} />);
    openPanel();
    fireEvent.change(searchBox(), { target: { value: "hit" } });
    expect(screen.getAllByRole("option")).toHaveLength(1 + PAGE_SIZE);
    expect(screen.getByText(/Finished 1–8 of 12/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText(/Finished 9–12 of 12/)).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(1 + 4);

    // Narrowing the query must not strand us on page 2 of the old result set.
    fireEvent.change(searchBox(), { target: { value: "hit-1" } });
    expect(screen.getByText("hit-1")).toBeTruthy();
    expect(screen.queryByText(/No team matches/)).toBeNull();
  });

  it("paging hands focus back to the search box, so typing keeps working", () => {
    render(<TeamSelector teams={many(29)} openTeam={null} onSelect={vi.fn()} />);
    openPanel();
    expect(document.activeElement).toBe(searchBox());

    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByText(/Finished 9–16 of 29/)).toBeTruthy();
    // Without this the next keystroke would vanish into a pager button.
    expect(document.activeElement).toBe(searchBox());
  });

  it("a printable key typed anywhere in the panel goes to the search box", () => {
    render(<TeamSelector teams={[...many(12, "hit"), ...many(12, "miss")]} openTeam={null} onSelect={vi.fn()} />);
    openPanel();
    (searchBox() as HTMLInputElement).blur(); // focus parked off the input

    // The keystroke is captured, not dropped: it seeds the query AND pulls focus
    // into the input, so every key after it types straight in.
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "h" });
    expect((searchBox() as HTMLInputElement).value).toBe("h");
    expect(document.activeElement).toBe(searchBox());

    fireEvent.change(searchBox(), { target: { value: "hit" } });
    expect(screen.getByText(/Finished 1–8 of 12/)).toBeTruthy(); // filtered + back on page 1
  });

  it("↑/↓ move the highlight and Enter selects it", () => {
    const onSelect = vi.fn();
    render(<TeamSelector teams={[liveTeam("l1", "alpha"), liveTeam("l2", "beta")]} openTeam={null} onSelect={onSelect} />);
    openPanel();
    const selected = (): string[] => screen.getAllByRole("option").map((o) => o.getAttribute("aria-selected") ?? "");

    fireEvent.keyDown(searchBox(), { key: "ArrowDown" }); // → alpha
    expect(selected()).toEqual(["false", "true", "false"]);
    fireEvent.keyDown(searchBox(), { key: "ArrowDown" }); // → beta
    expect(selected()).toEqual(["false", "false", "true"]);
    fireEvent.keyDown(searchBox(), { key: "ArrowUp" }); // back to alpha
    expect(selected()).toEqual(["false", "true", "false"]);

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("l1");
    expect(screen.queryByRole("listbox")).toBeNull(); // picking closes the panel
  });

  it("Enter on the pinned row selects the front door", () => {
    const onSelect = vi.fn();
    const open: OpenTeam = { id: "l1", channelId: "maya/team/l1", name: "alpha", live: true };
    render(<TeamSelector teams={[liveTeam("l1", "alpha")]} openTeam={open} onSelect={onSelect} />);
    openPanel();
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("");
  });

  it("Enter after a search selects the matching team, not the front door", () => {
    const onSelect = vi.fn();
    render(<TeamSelector teams={[liveTeam("l1", "alpha"), doneTeam("d1", "zeta")]} openTeam={null} onSelect={onSelect} />);
    openPanel();
    fireEvent.change(searchBox(), { target: { value: "zeta" } });
    fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("d1");
  });

  it("Escape closes the panel without selecting", () => {
    const onSelect = vi.fn();
    render(<TeamSelector teams={[liveTeam("l1", "alpha")]} openTeam={null} onSelect={onSelect} />);
    openPanel();
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking a row selects that team", () => {
    const onSelect = vi.fn();
    render(<TeamSelector teams={[liveTeam("l1", "alpha"), doneTeam("d1", "old")]} openTeam={null} onSelect={onSelect} />);
    const rows = openPanel();
    fireEvent.click(within(rows[2]!).getByText("old"));
    expect(onSelect).toHaveBeenCalledWith("d1");
  });

  it("archives a finished team without selecting it", () => {
    const onSelect = vi.fn();
    const onArchive = vi.fn();
    render(
      <TeamSelector
        teams={[liveTeam("l1", "alpha"), doneTeam("d1", "old")]}
        openTeam={null}
        onSelect={onSelect}
        onArchive={onArchive}
      />,
    );
    openPanel();
    fireEvent.click(screen.getByLabelText("Archive old"));
    expect(onArchive).toHaveBeenCalledWith("d1");
    expect(onSelect).not.toHaveBeenCalled();
    // Live teams and the front door are not archivable from here.
    expect(screen.queryByLabelText("Archive alpha")).toBeNull();
  });

  it("labels the trigger with the open team, and 'archived' once it's closed", () => {
    const open: OpenTeam = { id: "l1", channelId: "maya/team/l1", name: "alpha", live: true };
    const { rerender } = render(<TeamSelector teams={[liveTeam("l1", "alpha")]} openTeam={open} onSelect={vi.fn()} />);
    expect(screen.getByRole("combobox").textContent).toContain("alpha");

    // Closed+archived: the team is gone from the list, but the trigger still names it.
    rerender(<TeamSelector teams={[]} openTeam={open} archived onSelect={vi.fn()} />);
    expect(screen.getByRole("combobox").textContent).toContain("alpha");
    expect(screen.getByRole("combobox").textContent).toContain("archived");
  });
});
