import { describe, expect, it } from "vitest";
import { stackRoundTurns } from "../../web/src/app/App.js";

describe("round history stack", () => {
  it("shows the later guess above the player who guessed first", () => {
    const first = { turnNumber: 1, playerId: "p1" };
    const second = { turnNumber: 2, playerId: "p2" };
    expect(stackRoundTurns([first, second])).toEqual([second, first]);
  });
});
