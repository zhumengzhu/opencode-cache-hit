import { describe, test, expect } from "bun:test"
import {
  buildCostDisplayEmbed,
  createCostFormatter,
  createRateFormatter,
  normalizeCostDisplay,
  normalizeCostDisplayEmbed,
  sanitizeCostDisplayEmbed,
  DEFAULT_COST_DISPLAY,
  CURRENCY_PRESETS,
} from "../src/format-cost.ts"

describe("createCostFormatter", () => {
  test("zero returns empty", () => {
    expect(createCostFormatter({ currency: "CNY", costUnit: "USD", rate: 7.2 })(0)).toBe("")
  })

  test("negative stays visible", () => {
    const fmt = createCostFormatter(DEFAULT_COST_DISPLAY)
    expect(fmt(-0.75)).toBe("-¥5.077")
    expect(fmt(-0.0001)).toBe("-<¥0.01")
  })

  test("non-finite returns empty", () => {
    const fmt = createCostFormatter(DEFAULT_COST_DISPLAY)
    expect(fmt(Number.NaN)).toBe("")
    expect(fmt(Number.NEGATIVE_INFINITY)).toBe("")
  })

  test("USD cost to CNY display", () => {
    const fmt = createCostFormatter(DEFAULT_COST_DISPLAY)
    expect(fmt(0.1)).toBe("~¥0.677")
    expect(fmt(0.001)).toBe("<¥0.01")
  })

  test("USD display without convert", () => {
    const fmt = createCostFormatter({ currency: "USD", costUnit: "USD" })
    expect(fmt(0.065)).toBe("~$0.0650")
  })

  test("custom symbol", () => {
    const fmt = createCostFormatter({ currency: "CNY", costUnit: "USD", rate: 1, symbol: "元", decimals: 2 })
    expect(fmt(1)).toBe("~元1.00")
  })
})

describe("normalizeCostDisplay", () => {
  test("defaults USD→CNY when invalid", () => {
    const cfg = normalizeCostDisplay(null)
    expect(cfg.currency).toBe("CNY")
    expect(cfg.costUnit).toBe("USD")
    expect(cfg.rate).toBe(6.77)
  })

  test("parses costUnit and rate", () => {
    const cfg = normalizeCostDisplay({ currency: "CNY", costUnit: "USD", rate: 7 })
    expect(cfg.rate).toBe(7)
  })
})

describe("createRateFormatter", () => {
  test("formats per-million rate in display currency", () => {
    const fmt = createRateFormatter({ currency: "CNY", costUnit: "USD", rate: 7.2 })
    expect(fmt(3)).toBe("¥21.60")
  })

  test("no conversion when currency matches costUnit", () => {
    const fmt = createRateFormatter({ currency: "USD", costUnit: "USD" })
    expect(fmt(5)).toBe("$5.00")
  })

  test("uses custom symbol", () => {
    const fmt = createRateFormatter({ currency: "CNY", costUnit: "USD", rate: 1, symbol: "元" })
    expect(fmt(2.5)).toBe("元2.50")
  })

  test("handles zero rate", () => {
    const fmt = createRateFormatter({ currency: "USD", costUnit: "USD" })
    expect(fmt(0)).toBe("$0.00")
  })
})

describe("buildCostDisplayEmbed", () => {
  test("USD to CNY embed", () => {
    const e = buildCostDisplayEmbed(DEFAULT_COST_DISPLAY)
    expect(e.rate).toBe(6.77)
    expect(e.chartLabel).toBe("Cost (¥)")
    expect(e.costNote).toContain("USD")
    expect(e.costNote).toContain("CNY")
  })

  test("no note when currency matches cost unit", () => {
    const e = buildCostDisplayEmbed({ currency: "USD", costUnit: "USD" })
    expect(e.rate).toBe(1)
    expect(e.costNote).toBe("")
    expect(e.chartLabel).toBe("Cost ($)")
  })
})

describe("normalizeCostDisplayEmbed", () => {
  test("null uses plugin defaults (no config file)", () => {
    const e = normalizeCostDisplayEmbed(null)
    expect(e.currency).toBe("CNY")
    expect(e.costUnit).toBe("USD")
    expect(e.rate).toBe(6.77)
    expect(e.symbol).toBe("¥")
  })

  test("empty object uses defaults", () => {
    const e = normalizeCostDisplayEmbed({})
    expect(e.rate).toBe(6.77)
  })

  test("invalid currency and rate fall back", () => {
    const e = normalizeCostDisplayEmbed({ currency: "RMB", rate: -3, costUnit: "XXX" })
    expect(e.currency).toBe("CNY")
    expect(e.costUnit).toBe("USD")
    expect(e.rate).toBe(6.77)
  })

  test("partial config keeps valid rate", () => {
    const e = normalizeCostDisplayEmbed({ currency: "EUR", rate: 0.92 })
    expect(e.currency).toBe("EUR")
    expect(e.rate).toBe(0.92)
    expect(e.symbol).toBe("€")
  })
})

describe("sanitizeCostDisplayEmbed", () => {
  test("fixes NaN rate", () => {
    const e = sanitizeCostDisplayEmbed({
      currency: "CNY",
      costUnit: "USD",
      rate: NaN,
      symbol: "¥",
      decimals: 3,
      minDisplay: 0.01,
      chartLabel: "Cost (¥)",
      costNote: "",
    })
    expect(e.rate).toBe(6.77)
  })
})

describe("CURRENCY_PRESETS", () => {
  test("has common codes", () => {
    expect(CURRENCY_PRESETS.CNY.symbol).toBe("¥")
    expect(CURRENCY_PRESETS.USD.symbol).toBe("$")
  })
})
