import { describe, test, expect } from "bun:test"
import { createChildSessionSync } from "../src/child-session-sync.ts"

describe("createChildSessionSync", () => {
  test("loadChildren sets ids from list", async () => {
    let ids: string[] = ["stale"]
    const sync = createChildSessionSync({
      client: {
        list: async () => [
          { id: "a", parentID: "p" },
          { id: "b", parentID: "p" },
        ],
      },
      getParentId: () => "p",
      setChildIds: (next) => {
        ids = next
      },
    })
    sync.loadChildren()
    await new Promise((r) => setTimeout(r, 0))
    expect(ids).toEqual(["a", "b"])
  })

  test("resetForParentChange invalidates in-flight list", async () => {
    let ids: string[] = []
    let resolveList!: (v: unknown) => void
    const sync = createChildSessionSync({
      client: {
        list: () =>
          new Promise((resolve) => {
            resolveList = resolve
          }),
      },
      getParentId: () => "p",
      setChildIds: (next) => {
        ids = next
      },
    })
    sync.loadChildren()
    sync.resetForParentChange()
    resolveList([{ id: "late", parentID: "p" }])
    await new Promise((r) => setTimeout(r, 0))
    expect(ids).toEqual([])
  })

  test("onForeignSessionActivity ignores parent session id", () => {
    let listCalls = 0
    const sync = createChildSessionSync({
      client: {
        list: async () => {
          listCalls++
          return []
        },
      },
      getParentId: () => "p",
      setChildIds: () => {},
      debounceMs: 1000,
    })
    sync.onForeignSessionActivity("p")
    sync.onForeignSessionActivity(undefined)
    expect(listCalls).toBe(0)
  })
})
