# Voice rejoin review

Reviewed on 2026-10-02. There used to be one-sided rejoin failures: someone left and rejoined, appeared in the call, but audio stopped. Fixes were made. This review checks those fixes and the surrounding voice lifecycle.

The fixes are incomplete. Nine distinct defects were reproduced in local checks. Six additional failure paths were found by inspection. This review did not reproduce a native crash or establish the cause of a particular production incident.

## Scope and state

Both repos were cloned into `~/Projects`. Review work is on `review/voice-rejoin` in each repo. Application source, dependency manifests, release files, and deployment configuration are unchanged. Nothing was pushed or deployed.

| Component | Reviewed head | Review diff |
|---|---|---|
| Server | `d385b5c9596b45e3c519a778ed294eacaddc601d` | `git diff 7c67570...d385b5c` |
| TUI | `71ef1a45cbdccbfefacfc40050b32f07bcb5e42d` | `git diff 6dca851...71ef1a4` |

No fixed point was supplied, so the baselines are the Opus rewrite commits before the subsequent fixes. The user's reported rejoin behavior is the spec. Neither repo has the issue-tracker document expected by the code-review skill; no tracker setup was needed for this review.

## Reproduced defects

### 1. P1: Mute can permanently silence a sender

Locations: [jitterBuffer.ts](../src/voice/jitterBuffer.ts), lines 19–55; [client manager.rs](../../eurus-tui/src/voice/manager.rs), lines 348–356. Present since the Opus rewrite.

The client skips muted packets before incrementing its sequence number. The server advances `expectedSeq` while the stream is silent. After unmuting, arriving packets remain behind the server's cursor and are rejected. Both cursors then advance at the same rate, so the gap does not close.

Proof: encode and decode a real Opus tone through `VoiceSession`, pause input for 50 mixer ticks, then resume 100 packets. Before mute there is audio; after mute there are **0 audible frames out of 100**. The socket and voice session remain active.

Fix: stop predicting incoming sequence numbers from mixer wall time. WebSocket delivery is ordered; a small bounded FIFO of decoded frames, consuming one frame per tick and returning silence when empty, is simpler here. Keep sequence validation for duplicates/session boundaries if needed, but allow progress after idle periods and bursts. Merely recreating the session on leave/rejoin does not fix mute/unmute.

### 2. P1: Replacing a socket preserves stale room and voice membership

Locations: [server.ts](../src/server.ts), lines 123–137, 251–257, 369–373. Introduced by `d385b5c`.

The replacement path removes the old socket from `connectedUsers` before terminating it. Its close handler then cannot find the user and skips cleanup. `activeRoom.users` still holds the old `ConnectedUser`. Rejoining the same room does not replace that entry because the user ID already exists.

Proof: execute the real connection callback and room handlers. The new socket receives the direct room confirmation but misses a subsequent room broadcast. A separate check shows the old voice membership survives replacement. If the replacement joins a different room, the old room retains the ghost session.

Fix: clean the old connection's room/voice state before removing its connection entry, then terminate it. Match room membership to the socket that owns it, not only the user ID. Together with finding 3, this prevents an old handler from undoing replacement cleanup.

### 3. P1: An unfinished room join can resurrect a disconnected socket

Location: [server.ts](../src/server.ts), lines 302–373. Predates the latest replacement fix.

`handleJoinRoom` awaits database work and later adds the captured user without checking whether that connection is still current. Disconnect/replacement cleanup can run during either await. WebSocket message callbacks also run concurrently, so room transitions can overlap.

Proof: suspend the real room lookup, disconnect the socket, then resolve the lookup. The handler inserts the closed socket into the room after disconnect cleanup has finished.

Fix: recheck that `connectedUsers.get(user.ws) === user` and the socket is open after asynchronous boundaries, before mutating active state. Use a per-connection room-transition generation or serialize room transitions to prevent older joins from winning. Do not serialize high-rate audio behind unrelated database operations.

### 4. P1: Voice admission bypasses private-room access checks

Location: [server.ts](../src/server.ts), lines 956–980, 1017–1032. Present in the Opus rewrite.

`join_voice` checks whether the room is active, but never verifies that the sender joined it. A connected client knowing an active private room ID can create a voice session there. The mixer then treats that session as a participant. This is also how stale rejoin intent can attach a client to the wrong room.

Proof: call the real voice handler with a non-member and an active private room. The non-member is admitted to the voice engine.

Fix: require current chat-room membership owned by this socket before voice admission, audio input, or voice removal. Reject stale sockets and mismatched rooms. Return an explicit failure for denied joins. Private-room access must come through the existing authorized chat join path.

### 5. P1: The TUI cannot consume the incoming voice stream fast enough

Location: [client main.rs](../../eurus-tui/src/main.rs), lines 480–507 and 567. The receive bottleneck predates the latest fixes.

The UI reads one WebSocket message per iteration, then waits up to 50 ms for terminal input. The server produces one audio packet every 20 ms. With an idle terminal, the queue grows even on a healthy connection. Control messages and disconnect notifications share that queue.

Proof: run the exact production receive block and `handle_server_message` with 50 audio arrivals distributed across twenty virtual 50 ms ticks. Only **20 packets are forwarded; 30 remain queued** after one simulated second. Rendering cost was excluded, so it can only worsen this idle-input case.

Fix: drain pending incoming messages each iteration, with a sensible work limit to preserve keyboard responsiveness. Prefer forwarding audio from the socket task directly to a bounded audio queue if the UI still cannot keep up. Drop stale audio on leave/reconnect rather than playing accumulated history.

### 6. P1: Automatic reconnect clears mute

Location: [client manager.rs](../../eurus-tui/src/voice/manager.rs), lines 238–253, 447–452; [main.rs](../../eurus-tui/src/main.rs), lines 517–526. Relevant to the automatic rejoin introduced in `76dde1f`.

Transport disconnect calls the general voice reset, which clears `is_muted`. Automatic rejoin then restarts capture unmuted. The UI also resets its mute display on disconnect/Connected events.

Proof: put the real manager in a muted active session, invoke its disconnect handler, and inspect state. Rejoin intent is retained but mute is false.

Fix: preserve the user's mute preference across transport recovery in both manager and UI. Separate transport cleanup from explicit session reset. Restore the displayed mute state from the manager instead of assuming every Connected event means unmuted.

### 7. P1: Leaving during an outage does not cancel automatic rejoin

Location: [client manager.rs](../../eurus-tui/src/voice/manager.rs), lines 200–224 and 260–288. The early-return behavior is in `71ef1a4`.

Disconnect clears `in_voice` but retains `was_in_voice` and `room_id`. An explicit Leave then returns immediately because `in_voice` is false. Joining another chat room later triggers auto-rejoin to the remembered old room. If it still exists, finding 4 allows that join; otherwise the client can report success without server admission.

Proof: invoke the real manager's disconnect and leave handlers. `was_in_voice` remains true and `room_id` still names the old room. Ordinary leave while connected passes its control test.

Fix: explicit Leave must always cancel pending rejoin and clear remembered room identity, even with no live stream. Preserve the roster separately if the intent behind the early return was to avoid erasing other users.

### 8. P1: Invite and DM transitions leave voice attached to the previous room

Locations: [client main.rs](../../eurus-tui/src/main.rs), lines 1835–1853, 1932–1949, 2116–2125; [manager.rs](../../eurus-tui/src/voice/manager.rs), lines 260–288. Not covered by the latest room-leave fixes.

`:join <invite>` and `:dm <user>` switch chat rooms without telling the voice manager to leave. The server removes the old voice session, but capture keeps sending the old room ID. `RoomJoined` has no room ID in the voice command, so the manager cannot reconcile the change.

Proof: execute each actual command with an active voice session, then process a server room confirmation. Neither path emits Leave to the manager. The manager receives only a roomless `RoomJoined` notification.

Fix: pass the confirmed room ID through `RoomJoined` and reconcile voice centrally when the room changes. Stop the old session before accepting the new room. Do not add separate cleanup logic to every navigation command.

### 9. P1: Stereo playback consumes mono samples at the wrong rate

Location: [client audio.rs](../../eurus-tui/src/voice/audio.rs), lines 182–184 and 230–250. Present in the Opus rewrite.

The decoder produces mono samples, but the output callback writes one sample to each interleaved device slot. On a stereo device it consumes two mono samples per output frame instead of copying one sample to both channels. Audio is time-compressed within callbacks and the rest is filled with silence.

Proof: compile the production callback with only its unused device metadata type stubbed. Given four mono samples and eight stereo slots, output is `[0.1, 0.2, 0.3, 0.4, 0, 0, 0, 0]`; expected output is `[0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4]`. The mono control passes.

Fix: iterate device output in frames of `stream_config.channels`. Pop one mono sample per frame and copy it to every channel. Continue measuring the decoded queue in mono frames.

## Additional findings from inspection

These paths are visible in the code, but their complete user-facing failures were not reproduced with real devices/network outages here.

| Finding | Evidence and trigger | Concrete fix |
|---|---|---|
| 10. P1: Client success does not require server admission | `manager.rs:299–334,463–468` ignores missing/closed senders and declares success after capture starts. `main.rs:2271–2272` ignores voice acknowledgements. Server rejection can leave a green call with no session. | Propagate send errors. Keep the client Connecting until a matching server acknowledgement. Handle rejection/timeout by stopping capture and clearing pending state. |
| 11. P2: Old audio work can cross a session boundary | `manager.rs:341–410` retains no sender task handle; reset drops capture but queued encoder/sender work can drain using shared reset counters and the replacement socket. Incoming ordinary messages have no connection generation, and `handle_server_audio` checks only `in_voice`, not room identity. | Cancel and await the old sender, use session-owned counters, tag incoming messages with connection generation, and reject mismatched room/session audio. Avoid separate booleans that allow old work to look current. |
| 12. P2: Reconnect depends on the visible screen | `main.rs:420` restores chat only on `InRoom`. Help and RoomSwitcher retain room identity but do not satisfy the condition. Voice auto-rejoin waits for a RoomJoined that never comes. | Restore based on retained room membership, not the screen used to display it. |
| 13. P2: Device selection ignores sample format | `audio.rs:166–180,270–283` selects by rate; callbacks at `230,347` always use `f32`. Integer-only devices can fail despite advertising a supported rate. | Select an explicitly supported format and convert I16/U16 where necessary. Prefer supported F32 when available. Test actual integer-only device configurations. |
| 14. P2: Device failure can leave a dead session marked Connected | `manager.rs:149–159` only reports device errors. `audio.rs:137–153` permanently suppresses a failed playback peer until reset. Existing dead output streams are not removed on callback errors. | Stop or invalidate the affected stream, update connection state honestly, and provide a retry/rebuild path. A duplicate Join must not simply reconfirm a dead session. |
| 15. P2: Slow transports and audio tasks have no queue limit | `voiceSession.ts:117–120` sends every 20 ms without checking `bufferedAmount`; client capture, encoded audio, socket output and inbound routing use unbounded channels. | Bound audio queues and drop old frames under pressure. Check socket backlog before encoding/sending. Keep control messages deliverable. Verify memory stays bounded under a stalled receiver. |

The server's 300 MB production memory limit makes finding 15 worth addressing, but no production memory exhaustion was induced.

## What the existing fixes get right

- The mixer now pops each source once per tick. A real Opus test with three users confirms both listeners receive the speaker before and after three speaker leave/rejoin cycles.
- Voice state uses fresh sessions on rejoin, and ordinary explicit leave clears the manager's session intent in the local control test.
- Playback senders are reused rather than rebuilding the output stream for every packet. That removes the previous stream churn, but channel layout still needs fixing.
- Disconnect generation checks protect against old disconnect notifications. They do not cover old ordinary messages or queued microphone work.
- Heartbeat and room-delete cleanup are present. No live heartbeat/deletion scenario was exercised in this review.

## Standards

Independent standards review found three documented-rule violations:

1. `server.ts:140,142,269,275` adds four `as any` casts for heartbeat state, contrary to the supplied TypeScript rule. A `WeakSet<WebSocket>` or an explicit socket type removes them.
2. `eurus-tui/src/voice/debug.rs:27` and changed paths in `manager.rs:353,464` use unguarded mutex `unwrap()`, contrary to the supplied Rust rule. Handle lock poisoning explicitly. This does not establish a cause for the reported failure.
3. `main.rs:1956` rejects all `:vc` arguments while `docs/commands.md:38–41,63,75` still teaches `:vc join/leave/mute/unmute`. Rewrite those examples to `:vc`, `:vcl`, `:m`, and `:um`.

No additional code-smell finding warrants structural churn.

## Spec

Independent spec review used the user's requirement, “voice chat not working if you leave and join,” and the symptom, “even tho you were in the call.” It identified five unmet behaviors:

1. Leaving during an outage does not cancel rejoin. Reproduced in finding 7.
2. Invite/DM transitions leave voice in the previous room. Reproduced in finding 8.
3. Reconnect fails to restore membership from Help/RoomSwitcher. Inspection finding 12.
4. Reconnect clears mute. Reproduced in finding 6.
5. Stopped microphone tasks can drain into a new session. Inspection finding 11.

One unrelated scope change appears in the reviewed range: client commit `044512b` deletes `.github/workflows/release.yml`. Confirm that removing automated releases was intentional before including it in a voice repair release.

Axis totals: three Standards findings, five Spec behavior findings and one scope finding. Standards' most user-visible issue is stale command documentation; Spec's highest-risk issue is reconnect clearing mute.

## Reproduce locally

Requirements used here: Node 24, installed server dependencies, Rust stable, ALSA/Opus development libraries. No production credentials or database are needed. Run from the cloned repos:

```sh
cd ~/Projects/eurus-server
npm ci --no-audit --no-fund
npm run build
node --import tsx --test scripts/voice-review.cjs
```

```sh
cd ~/Projects/eurus-tui
~/.cargo/bin/cargo test --locked --test voice_review --test voice_room_review --no-fail-fast review::
node scripts/voice-playback-review.cjs
node scripts/voice-receive-review.cjs
```

These checks assert correct behavior. They exit nonzero on the reviewed heads. On `fix/voice-rejoin` in both repos they serve as the regression tests and all pass; harness signatures were updated where the fixes changed APIs.

| Check | Observed result |
|---|---|
| Server TypeScript build | Passed |
| Rust compilation, including actual client binary | Passed, with existing warnings |
| Server audit | 1 passed, 5 failed; replacement has two distinct assertions |
| Rust manager/room audit | 1 passed, 4 failed; invite and DM have separate checks |
| Playback callback audit | 1 passed, 1 failed |
| Receive-loop audit | 0 passed, 1 failed |

The server audit extracts actual handler declarations and the connection callback with the TypeScript parser, substitutes socket/database I/O, and uses real voice classes/native Opus. Mixer timers are virtual. It does not start the HTTP server. The Rust checks include unchanged production modules. The playback check compiles the production output fill code: the callback on the reviewed head, `fill_output` on the fix branch. The receive check temporarily generates one Cargo test containing the unchanged UI receive block, runs it, and removes that generated file.

No microphone, physical speaker, live database, full terminal session, or deployed service was tested. The reproduced failures establish specific code defects; they do not prove every historical rejoin report has the same cause.

## Fix order

1. Close voice admission and socket-ownership gaps. They permit wrong-room audio and stale membership.
2. Fix receive draining, jitter behavior and stereo output. They break ordinary healthy calls without a reconnect.
3. Make room identity and explicit leave authoritative. Preserve mute on recovery and require server acknowledgement before reporting Connected.
4. Cancel old tasks, reject old-generation audio, then bound queues and recover device errors.

Keep each change small and use the matching failing check as its regression test. Afterward, run a two-client device test covering repeated leave/join, mute/unmute, reconnect while muted, switching rooms during an outage, stereo playback, and device removal/recovery. No additional transport or media framework is needed to fix these defects.
