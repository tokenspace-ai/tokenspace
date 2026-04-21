import { describe, expect, it } from "bun:test";
import { normalizeApprovalPayload, normalizeApprovalRecord, normalizeApprovalRequestRecord } from "../approvalPayloads";

describe("approval payload normalization", () => {
  it("parses stringified JSON objects and arrays", () => {
    expect(normalizeApprovalPayload('{"ticketId":"123","force":true}')).toEqual({
      ticketId: "123",
      force: true,
    });
    expect(normalizeApprovalPayload('[{"id":1}]')).toEqual([{ id: 1 }]);
  });

  it("leaves plain strings untouched", () => {
    expect(normalizeApprovalPayload("ticket-123")).toBe("ticket-123");
    expect(normalizeApprovalPayload('{"ticketId"')).toBe('{"ticketId"');
  });

  it("normalizes approval records used for runtime matching", () => {
    expect(
      normalizeApprovalRecord({
        action: "tickets:update",
        data: '{"ticketId":"123","fields":{"status":"done"}}',
      }),
    ).toEqual({
      action: "tickets:update",
      data: {
        ticketId: "123",
        fields: { status: "done" },
      },
    });
  });

  it("normalizes approval request records for debug and UI views", () => {
    expect(
      normalizeApprovalRequestRecord({
        action: "tickets:update",
        data: '{"ticketId":"123"}',
        info: '{"displayName":"Ticket 123"}',
      }),
    ).toEqual({
      action: "tickets:update",
      data: { ticketId: "123" },
      info: { displayName: "Ticket 123" },
    });
  });
});
