/**
 * Post-hangup padding ends when the app is backgrounded.
 *
 * ## The regression this pins
 *
 * After a connected DM call ends, CallContext keeps the circuit alive sending
 * CBR silence until the next rotation boundary (≤ ~5.5 min), so a relay can't
 * line teardown up with the end of the call. The teardown was a JS
 * setTimeout, and JS timers don't fire while the app is in the background on
 * Android. Hang up, leave the app, and the silent stream ran until the app was
 * next opened — hours of audio bandwidth instead of minutes. The padding
 * itself is deliberate and is kept; only its unbounded tail is cut.
 *
 * ## What is asserted
 *
 * - The decision: end padding on 'background', and on 'active' once the
 *   deadline has passed; leave it alone on 'inactive' (control centre, the
 *   switcher peek) and on an early return to the foreground.
 * - From the provider source (no harness drives a WebRTC call here): an
 *   AppState listener applies that decision while padding, the early
 *   teardown releases the circuit exactly as the timer does, and padding that
 *   starts with the app already backgrounded is ended at once.
 */
import * as fs from 'fs';
import * as path from 'path';
import { paddingActionForAppState } from '../services/calling/postHangupPadding';

const DEADLINE = 1_750_000_300_000;

describe('paddingActionForAppState', () => {
  it('ends padding when the app goes to the background', () => {
    expect(paddingActionForAppState('background', DEADLINE, DEADLINE - 200_000)).toBe('end-now');
  });

  it('ends padding on return to the foreground once the deadline has passed', () => {
    expect(paddingActionForAppState('active', DEADLINE, DEADLINE)).toBe('end-now');
    expect(paddingActionForAppState('active', DEADLINE, DEADLINE + 3_600_000)).toBe('end-now');
  });

  it('leaves padding to its timer on an early return to the foreground', () => {
    // The privacy feature: a user who stays in the app pads to the boundary.
    expect(paddingActionForAppState('active', DEADLINE, DEADLINE - 1)).toBe('keep');
  });

  it("ignores 'inactive', which is not the user leaving", () => {
    expect(paddingActionForAppState('inactive', DEADLINE, DEADLINE + 1)).toBe('keep');
  });

  it('keeps padding with no deadline on record', () => {
    expect(paddingActionForAppState('active', null, DEADLINE)).toBe('keep');
  });
});

describe('CallContext wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'context', 'CallContext.tsx'), 'utf8');

  function section(startAnchor: string, endAnchor: string): string {
    const start = source.indexOf(startAnchor);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(endAnchor, start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('listens for app state changes and ends padding on the decision', () => {
    expect(source).toMatch(/AppState\.addEventListener\('change'/);
    const listener = section("AppState.addEventListener('change'", 'return () => sub.remove();');
    expect(listener).toContain('isPaddingRef.current');
    expect(listener).toContain('paddingActionForAppState(nextState, paddingDeadlineRef.current');
    expect(listener).toContain('finishPadding(');
  });

  it('releases the circuit when padding is ended early, as the timer does', () => {
    const finish = section('const finishPadding = useCallback', '}, []);');
    expect(finish).toContain('webrtcRef.current.cleanup()');
    expect(finish).toContain('relayClientRef.current.releaseCircuit(circuitId)');
  });

  it('records the deadline and circuit when padding starts, and checks the current app state', () => {
    const start = section('webrtcRef.current.muteForPadding();', '} else {');
    expect(start).toContain('paddingDeadlineRef.current = teardownAt');
    expect(start).toContain('paddingCircuitIdRef.current = circuitId');
    expect(start).toContain('paddingActionForAppState(AppState.currentState');
  });
});
