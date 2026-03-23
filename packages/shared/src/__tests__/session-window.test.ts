import { SessionWindow } from "../session-window.js";

describe("SessionWindow", () => {
  it("fires synthesis after inactivity timeout", async () => {
    const onSynth = jest.fn();
    const win = new SessionWindow("ch1", 100, onSynth);
    win.touch();
    await new Promise(r => setTimeout(r, 200));
    expect(onSynth).toHaveBeenCalledWith("ch1");
    win.destroy();
  });

  it("resets timer on touch", async () => {
    const onSynth = jest.fn();
    const win = new SessionWindow("ch1", 150, onSynth);
    win.touch();
    await new Promise(r => setTimeout(r, 80));
    win.touch();
    await new Promise(r => setTimeout(r, 80));
    expect(onSynth).not.toHaveBeenCalled();
    await new Promise(r => setTimeout(r, 100));
    expect(onSynth).toHaveBeenCalledTimes(1);
    win.destroy();
  });
});
