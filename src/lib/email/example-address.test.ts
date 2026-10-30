import { expect, it } from "vitest";
import { isExampleAddress } from "./example-address";

it("spots example.com, .org, and .net senders, bare or with a display name", () => {
  expect(isExampleAddress("schedule@example.com")).toBe(true);
  expect(isExampleAddress("AW appointment matching <schedule@example.com>")).toBe(true);
  expect(isExampleAddress("a@mail.example.org")).toBe(true);
  expect(isExampleAddress("a@EXAMPLE.NET")).toBe(true);
  expect(isExampleAddress("AW <schedule@dennison.ca>")).toBe(false);
  expect(isExampleAddress("a@notexample.com")).toBe(false);
});
