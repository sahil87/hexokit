import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PoppedOutPlaceholder, PopoutEnded } from "./popout-states";

afterEach(cleanup);

describe("PoppedOutPlaceholder", () => {
  it("renders one row per popped leaf and fires Pop back in per leaf", () => {
    const onPopIn = vi.fn();
    render(
      <PoppedOutPlaceholder
        leaves={[
          { leafId: "tty", kind: "tty" },
          { leafId: "@12/tty", kind: "tty", homeName: "agent-3" },
        ]}
        onPopIn={onPopIn}
      />,
    );
    expect(screen.getByTestId("popped-out-placeholder")).toBeTruthy();
    expect(screen.getAllByText(/is popped out/)).toHaveLength(2);
    // A foreign leaf disambiguates with its home window's name.
    expect(screen.getByText("agent-3 Terminal")).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Pop Terminal back in")[1]);
    expect(onPopIn).toHaveBeenCalledWith("@12/tty");
  });
});

describe("PopoutEnded", () => {
  it("renders the ended state without navigating affordances", () => {
    render(<PopoutEnded />);
    expect(screen.getByTestId("popout-ended")).toBeTruthy();
    expect(screen.getByText("Window closed")).toBeTruthy();
  });
});
