import { expect, it } from "vitest";
import { allowedSenderDomain, domainOf, isOffDomain, offDomainMessage } from "./sender-domain";

it("reads the domain of a bare address or a display-name address", () => {
  expect(domainOf("info@MyAssociationsWest.org")).toBe("myassociationswest.org");
  expect(domainOf("AW Appointment Show <info@myassociationswest.org>")).toBe("myassociationswest.org");
  expect(domainOf("not an address")).toBeNull();
  expect(domainOf("name@")).toBeNull();
});

it("allows only the domain of EMAIL_FROM, and nothing while it is a placeholder", () => {
  expect(allowedSenderDomain("AW <info@myassociationswest.org>")).toBe("myassociationswest.org");
  expect(allowedSenderDomain("AW appointment matching <schedule@example.com>")).toBeNull();
  expect(allowedSenderDomain("no at sign")).toBeNull();
});

it("flags an address off the allowed domain, subdomains included", () => {
  const allowed = "myassociationswest.org";
  expect(isOffDomain("laura@myassociationswest.org", allowed)).toBe(false);
  expect(isOffDomain("Laura@MyAssociationsWest.org", allowed)).toBe(false);
  expect(isOffDomain("laura@gmail.com", allowed)).toBe(true);
  expect(isOffDomain("laura@mail.myassociationswest.org", allowed)).toBe(true);
  expect(isOffDomain("laura@myassociationswest.org.evil.com", allowed)).toBe(true);
  expect(isOffDomain("laura@anything.com", null)).toBe(false);
});

it("names the domain in the message", () => {
  expect(offDomainMessage("myassociationswest.org")).toBe("Use an address on myassociationswest.org.");
});
