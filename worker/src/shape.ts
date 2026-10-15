// Turns arbitrary JSON into rows: a preview for the UI and CSV for Power BI / Excel.

import { HttpError } from "./http";

type Row = Record<string, unknown> | unknown[];

export interface Preview {
  kind: "objects" | "arrays" | "values" | "object" | "scalar";
  /** Key of the array that was used when the response is `{ "<key>": [ ... ] }`. */
  arrayPath: string | null;
  rowCount: number | null;
  columns: string[];
  rows: string[][];
}

/** Finds the array to tabulate: the top level, or the only array property of a top-level object. */
function findRows(data: unknown): { rows: unknown[]; path: string | null } | null {
  if (Array.isArray(data)) return { rows: data, path: null };
  if (data && typeof data === "object") {
    const arrays = Object.entries(data).filter(([, v]) => Array.isArray(v));
    if (arrays.length === 1) return { rows: arrays[0][1] as unknown[], path: arrays[0][0] };
  }
  return null;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Columns + string cells for a list of rows (objects → union of keys; arrays → header row if it looks like one). */
function tabulate(rows: unknown[], forPreview: boolean): { columns: string[]; body: string[][] } {
  if (rows.length > 0 && rows.every(isRecord)) {
    const columns: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) seen.add(k), columns.push(k);
    return { columns, body: rows.map((r) => columns.map((c) => cell(r[c]))) };
  }
  if (rows.length > 0 && rows.every(Array.isArray)) {
    const arrs = rows as unknown[][];
    const width = Math.max(...arrs.map((a) => a.length));
    const headerLike = forPreview && arrs.length > 1 && arrs[0].length === width && arrs[0].every((v) => typeof v === "string" && v !== "");
    const columns = headerLike ? (arrs[0] as string[]) : Array.from({ length: width }, (_, i) => `Column${i + 1}`);
    const data = headerLike ? arrs.slice(1) : arrs;
    return { columns, body: data.map((a) => Array.from({ length: width }, (_, i) => cell(a[i]))) };
  }
  return { columns: ["value"], body: rows.map((v) => [cell(v)]) };
}

export function buildPreview(data: unknown, limit = 5): Preview {
  const found = findRows(data);
  if (!found) {
    if (isRecord(data)) {
      const entries = Object.entries(data).slice(0, 20);
      return { kind: "object", arrayPath: null, rowCount: null, columns: ["key", "value"], rows: entries.map(([k, v]) => [k, cell(v).slice(0, 200)]) };
    }
    return { kind: "scalar", arrayPath: null, rowCount: null, columns: ["value"], rows: [[cell(data)]] };
  }
  const sample = found.rows.slice(0, limit + 1);
  const { columns, body } = tabulate(sample, true);
  const kind = sample.length && sample.every(isRecord) ? "objects" : sample.length && sample.every(Array.isArray) ? "arrays" : "values";
  return {
    kind,
    arrayPath: found.path,
    rowCount: found.rows.length,
    columns: columns.slice(0, 30),
    rows: body.slice(0, limit).map((r) => r.slice(0, 30).map((c) => (c.length > 200 ? `${c.slice(0, 200)}…` : c))),
  };
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV for a flat array (objects or arrays), or for `{ key: [ ... ] }`. UTF-8 BOM so Excel detects the encoding. */
export function toCsv(data: unknown): string {
  const found = findRows(data);
  if (!found) throw new HttpError(422, "CSV is only available when the response is an array (or an object with a single array property).");
  const rows = found.rows as Row[];
  const { columns, body } = tabulate(rows, false);
  const isArrays = rows.length > 0 && rows.every(Array.isArray);
  const lines = isArrays ? [] : [columns.map(csvField).join(",")];
  for (const r of body) lines.push(r.map(csvField).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
