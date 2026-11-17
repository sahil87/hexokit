import { describe, it, expect, beforeEach } from "vitest";
import { useSelectionStore } from "./selection-store";

// The sidebar window-row multi-select store. The set arithmetic itself is
// covered in lib/selection.test.ts; this covers the store's own contract —
// anchor movement, no-op writes, and prune's anchor invalidation.

function state() {
  return useSelectionStore.getState();
}

function selectedKeys(): string[] {
  return [...state().selected];
}

describe("selection-store", () => {
  beforeEach(() => {
    useSelectionStore.setState({ selected: new Set(), anchor: null });
  });

  describe("toggle", () => {
    it("adds a key and moves the anchor to it", () => {
      state().toggle("s:@1");
      expect(selectedKeys()).toEqual(["s:@1"]);
      expect(state().anchor).toBe("s:@1");
    });

    it("removes an already-selected key (and still moves the anchor)", () => {
      state().toggle("s:@1");
      state().toggle("s:@2");
      state().toggle("s:@1");
      expect(selectedKeys()).toEqual(["s:@2"]);
      expect(state().anchor).toBe("s:@1");
    });
  });

  describe("seed", () => {
    it("starts an empty selection from the key and anchors on it", () => {
      state().seed("s:@1");
      expect(selectedKeys()).toEqual(["s:@1"]);
      expect(state().anchor).toBe("s:@1");
    });

    it("leaves a live selection (and its anchor) untouched", () => {
      state().toggle("s:@2");
      const before = state().selected;
      state().seed("s:@1");
      expect(state().selected).toBe(before);
      expect(state().anchor).toBe("s:@2");
    });
  });

  describe("select", () => {
    it("adds keys without touching the anchor", () => {
      state().toggle("s:@1");
      state().select(["s:@2", "s:@3"]);
      expect(selectedKeys().sort()).toEqual(["s:@1", "s:@2", "s:@3"]);
      expect(state().anchor).toBe("s:@1");
    });

    it("is a no-op write when every key is already selected", () => {
      state().select(["s:@1"]);
      const before = state().selected;
      state().select(["s:@1"]);
      expect(state().selected).toBe(before);
    });
  });

  describe("selectOnly", () => {
    it("replaces the whole selection and anchors on the last key", () => {
      state().toggle("s:@9");
      state().selectOnly(["s:@1", "s:@2"]);
      expect(selectedKeys()).toEqual(["s:@1", "s:@2"]);
      expect(state().anchor).toBe("s:@2");
    });

    it("clears the anchor when given no keys", () => {
      state().toggle("s:@1");
      state().selectOnly([]);
      expect(selectedKeys()).toEqual([]);
      expect(state().anchor).toBeNull();
    });
  });

  describe("clear", () => {
    it("empties the selection and drops the anchor", () => {
      state().selectOnly(["s:@1", "s:@2"]);
      state().clear();
      expect(selectedKeys()).toEqual([]);
      expect(state().anchor).toBeNull();
    });

    it("is a no-op write when already empty", () => {
      const before = state().selected;
      state().clear();
      expect(state().selected).toBe(before);
    });
  });

  describe("prune", () => {
    it("drops keys whose rows are gone", () => {
      state().selectOnly(["s:@1", "s:@2"]);
      state().prune(new Set(["s:@1"]));
      expect(selectedKeys()).toEqual(["s:@1"]);
    });

    it("drops a stale anchor whose row vanished", () => {
      state().toggle("s:@2");
      state().select(["s:@1"]);
      state().prune(new Set(["s:@1"]));
      expect(state().anchor).toBeNull();
      expect(selectedKeys()).toEqual(["s:@1"]);
    });

    it("performs no state write when every selected row is still live", () => {
      state().selectOnly(["s:@1"]);
      const before = state().selected;
      state().prune(new Set(["s:@1", "s:@2"]));
      expect(state().selected).toBe(before);
      expect(state().anchor).toBe("s:@1");
    });
  });

  describe("settleBatch", () => {
    // The bulk move is fire-and-forget behind an already-closed palette, so its
    // terminal selection update races the user. `settleBatch` scopes that write
    // to the keys the batch actually owned instead of clobbering the store.

    it("drops the batch's succeeded keys, leaving the failed ones (the retry affordance)", () => {
      state().selectOnly(["s:@1", "s:@2", "s:@3"]);
      state().settleBatch(["s:@1", "s:@2", "s:@3"], ["s:@2"]);
      expect(selectedKeys()).toEqual(["s:@2"]);
    });

    it("empties the selection on a fully-successful batch", () => {
      state().selectOnly(["s:@1", "s:@2"]);
      state().settleBatch(["s:@1", "s:@2"], []);
      expect(selectedKeys()).toEqual([]);
      expect(state().anchor).toBeNull();
    });

    it("performs no state write on a total-failure batch (whole selection intact)", () => {
      state().selectOnly(["s:@1", "s:@2"]);
      const before = state().selected;
      state().settleBatch(["s:@1", "s:@2"], ["s:@1", "s:@2"]);
      expect(state().selected).toBe(before);
      expect(state().anchor).toBe("s:@2");
    });

    it("does NOT clobber a NEW selection the user built while the batch ran", () => {
      // The batch owned @1/@2 and succeeded on both; meanwhile the user cleared
      // and selected @7/@8. A terminal `clear()` would wipe the new selection.
      state().selectOnly(["s:@1", "s:@2"]);
      state().selectOnly(["s:@7", "s:@8"]);
      state().settleBatch(["s:@1", "s:@2"], []);
      expect(selectedKeys().sort()).toEqual(["s:@7", "s:@8"]);
      expect(state().anchor).toBe("s:@8");
    });

    it("does NOT re-add its failed keys over a new selection", () => {
      // Same race, partial failure: a terminal `selectOnly(failedKeys)` would
      // replace the user's new selection with this batch's leftovers.
      state().selectOnly(["s:@1", "s:@2"]);
      state().selectOnly(["s:@7"]);
      state().settleBatch(["s:@1", "s:@2"], ["s:@2"]);
      expect(selectedKeys()).toEqual(["s:@7"]);
      expect(state().anchor).toBe("s:@7");
    });

    it("drops the anchor only when it pointed at one of the batch's removed keys", () => {
      state().selectOnly(["s:@1", "s:@2"]);
      expect(state().anchor).toBe("s:@2");
      state().settleBatch(["s:@1", "s:@2"], ["s:@1"]);
      expect(state().anchor).toBeNull();

      state().selectOnly(["s:@3", "s:@4"]);
      state().settleBatch(["s:@3"], []);
      expect(state().anchor).toBe("s:@4");
    });
  });
});
