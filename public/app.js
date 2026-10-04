import { PoseLandmarker, FilesetResolver, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const $ = (id) => document.getElementById(id);
const CALIBRATION_SECONDS = 4;
const RECOVER_SECONDS = 3;
const SENSITIVITY = { low: 1.4, medium: 1, high: 0.7 };
const video = $("video"), canvas = $("overlay"), context = canvas.getContext("2d");
const drawing = new DrawingUtils(context);
let user = JSON.parse(localStorage.getItem("posturepal.user") || "null");
let baseline = user ? JSON.parse(localStorage.getItem(`posturepal.baseline.${user.id}`) || "null") : null;
let landmarker, stream, frame, heartbeat, activationPoll;
let mode = "idle", samples = [], smooth, lastFrame = 0, sessionStart = 0;
let badStreak = 0, goodStreak = 0, alerted = false;
let stats = freshStats();

function freshStats() { return { goodSeconds: 0, badSeconds: 0, awaySeconds: 0, issueCounts: {} }; }
function saveUser() { user ? localStorage.setItem("posturepal.user", JSON.stringify(user)) : localStorage.removeItem("posturepal.user"); }
function flash(text, duration = 3500) {
  $("banner").textContent = text;
  $("banner").classList.remove("hidden");
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => $("banner").classList.add("hidden"), duration);
}
function status(text, kind = "") { $("status").textContent = text; $("status").className = `status ${kind}`; }
function roundedStats() {
  return {
    goodSeconds: Math.round(stats.goodSeconds), badSeconds: Math.round(stats.badSeconds), awaySeconds: Math.round(stats.awaySeconds),
    issueCounts: Object.fromEntries(Object.entries(stats.issueCounts).map(([key, value]) => [key, Math.round(value)])),
  };
}
async function post(path, data = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: user?.id, ...data }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function showView() {
  const signedIn = Boolean(user);
  $("signup").classList.toggle("hidden", signedIn);
  $("tracker").classList.toggle("hidden", !signedIn);
  $("hello").classList.toggle("hidden", !signedIn);
  $("signOutBtn").classList.toggle("hidden", !signedIn);
  document.querySelectorAll(".launch-panel").forEach((node) => {
    if (node.id === "signup") return;
    node.classList.toggle("hidden", signedIn);
  });
  document.querySelector(".ghost-link")?.classList.toggle("hidden", signedIn);
  if (signedIn) {
    $("hello").textContent = `Hi, ${user.firstName}`;
    setActivated(user.activated);
    $("calibInfo").textContent = baseline ? `Calibrated ${new Date(baseline.calibratedAt).toLocaleString()}` : "Your first session begins with a quick calibration.";
    $("tracker").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
function setActivated(active) {
  if (!user) return;
  user.activated = active;
  saveUser();
  $("activateBanner").classList.toggle("hidden", active);
  clearInterval(activationPoll);
  if (!active) activationPoll = setInterval(verifyUser, 5000);
}
async function verifyUser() {
  if (!user) return;
  try {
    const result = await post("/api/me");
    if (result.user.activated !== user.activated) setActivated(result.user.activated);
    applySettings(result.settings);
  } catch {}
}

function applySettings(settings) {
  if (!settings) return;
  $("slouchSeconds").value = String(settings.slouchSeconds);
  $("slouchSeconds").oninput();
  $("sensitivity").value = settings.sensitivity;
  $("voiceId").value = settings.voiceId;
  $("audioEnabled").checked = settings.audioEnabled;
}

async function saveSettings() {
  if (!user) return;
  await post("/api/settings", {
    slouchSeconds: Number($("slouchSeconds").value),
    sensitivity: $("sensitivity").value,
    voiceId: $("voiceId").value,
    audioEnabled: $("audioEnabled").checked,
  }).catch(() => {});
}

async function initializePose() {
  if (landmarker) return;
  status("Loading posture model…");
  const files = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  landmarker = await PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", delegate: "GPU" },
    runningMode: "VIDEO",
    numPoses: 1,
  });
}
async function cameraOn() {
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 720 }, audio: false });
  video.srcObject = stream;
  await video.play();
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  $("placeholder").classList.add("hidden");
  $("pill").className = "pill on"; $("pill").textContent = "● Tracking (camera on)";
}
function cameraOff() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null; video.srcObject = null;
  cancelAnimationFrame(frame);
  context.clearRect(0, 0, canvas.width, canvas.height);
  $("placeholder").classList.remove("hidden");
  $("pill").className = "pill off"; $("pill").textContent = "● Camera off";
}

const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function measure(points) {
  if (![0, 11, 12].every((index) => (points[index].visibility ?? 1) > .5)) return null;
  const shoulders = middle(points[11], points[12]), ears = middle(points[7], points[8]);
  const width = Math.hypot(points[11].x - points[12].x, points[11].y - points[12].y);
  if (width < .05) return null;
  return {
    headHeight: (shoulders.y - points[0].y) / width,
    earHeight: (shoulders.y - ears.y) / width,
    shoulderWidth: width,
    tilt: Math.abs(points[11].y - points[12].y) / width,
  };
}
function smoothed(raw) {
  if (!smooth) return smooth = { ...raw };
  for (const key in raw) smooth[key] = smooth[key] * .8 + raw[key] * .2;
  return smooth;
}
function issuesFor(value) {
  const multiplier = SENSITIVITY[$("sensitivity").value];
  const issues = [];
  if (value.headHeight < baseline.headHeight * (1 - .15 * multiplier)) issues.push("slouching");
  else if (value.earHeight < baseline.earHeight * (1 - .18 * multiplier)) issues.push("head forward");
  if (value.shoulderWidth > baseline.shoulderWidth * (1 + .15 * multiplier)) issues.push("leaning in");
  if (value.tilt > baseline.tilt + .1 * multiplier) issues.push("tilted");
  return issues;
}
function loop() {
  if (!stream) return;
  const now = performance.now(), delta = lastFrame ? Math.min((now - lastFrame) / 1000, 1) : 0;
  lastFrame = now;
  const result = landmarker.detectForVideo(video, now);
  context.clearRect(0, 0, canvas.width, canvas.height);
  const points = result.landmarks?.[0];
  if (points) {
    drawing.drawConnectors(points, PoseLandmarker.POSE_CONNECTIONS, { color: "#d9f28a", lineWidth: 3 });
    drawing.drawLandmarks(points.slice(0, 13), { color: "#ffffff", radius: 3 });
  }
  const raw = points ? measure(points) : null;
  if (mode === "calibrating" && raw) samples.push(raw);
  if (mode === "tracking") track(raw, delta);
  frame = requestAnimationFrame(loop);
}
function track(raw, delta) {
  if (!raw) {
    stats.awaySeconds += delta; badStreak = 0; alerted = false;
    return status("Away — tracking paused", "away");
  }
  const value = smoothed(raw), issues = issuesFor(value);
  $("metrics").innerHTML = Object.entries(value).map(([key, number]) => `<li>${key}: ${number.toFixed(2)}</li>`).join("");
  if (issues.length) {
    stats.badSeconds += delta; badStreak += delta; goodStreak = 0;
    issues.forEach((issue) => stats.issueCounts[issue] = (stats.issueCounts[issue] || 0) + delta);
    status(`Slouch detected · ${Math.round(badStreak)}s`, "bad");
    if (badStreak >= Number($("slouchSeconds").value) && !alerted) {
      alerted = true;
      void alertUser(issues[0], Math.round(badStreak));
    }
  } else {
    stats.goodSeconds += delta; goodStreak += delta;
    if (goodStreak >= RECOVER_SECONDS) { badStreak = 0; alerted = false; }
    status("Good posture", "good");
  }
  const seconds = Math.floor((Date.now() - sessionStart) / 1000);
  $("timer").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const measured = stats.goodSeconds + stats.badSeconds;
  $("goodPct").textContent = measured ? `${Math.round(stats.goodSeconds / measured * 100)}%` : "–";
}

async function speak(result) {
  if (!$("audioEnabled").checked || !result.message) return;
  if (result.audioUrl) {
    try {
      await playAlertAudio(result.audioUrl);
      return;
    } catch (error) {
      console.warn("ElevenLabs playback failed; falling back to browser speech.", error);
    }
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(result.message);
  utterance.rate = 1.05;
  utterance.volume = 1;
  speechSynthesis.speak(utterance);
}

let audioContext;
async function playAlertAudio(relativeUrl) {
  const response = await fetch(new URL(relativeUrl, location.origin).href, { cache: "no-store" });
  if (!response.ok) throw new Error(`audio HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) throw new Error("audio empty");
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") await audioContext.resume();
  const decoded = await audioContext.decodeAudioData(buffer.slice(0));
  const source = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  gain.gain.value = 1.85;
  source.buffer = decoded;
  source.connect(gain);
  gain.connect(audioContext.destination);
  await new Promise((resolve, reject) => {
    source.onended = resolve;
    source.onerror = reject;
    source.start(0);
  });
}
async function alertUser(issue, seconds) {
  try {
    const result = await post("/api/alert", { issue, seconds });
    await speak(result);
    if (!result.sent) return flash(`Voice alert played; iMessage not sent: ${deliveryReason(result.reason)}`, 6000);
    $("alerts").textContent = String(Number($("alerts").textContent) + 1);
    flash(`iMessage sent · ${result.message}`);
  } catch (error) { flash(error.message); }
}
function deliveryReason(reason) {
  return {
    "photon-not-configured": "Photon credentials are not configured",
    "needs-reply": "reply “hi” to the welcome iMessage first",
    "not-allowed": "this number is not allowed in the Photon project",
    "send-error": "Photon rejected the send; check server logs",
    "unsubscribed": "this number is unsubscribed",
  }[reason] || reason || "unknown delivery error";
}
function showWelcomeDelivery(result) {
  const delivery = result.delivery;
  if (!delivery) return flash("Could not verify iMessage delivery status.", 6000);
  if (delivery.status === "sent") {
    $("activateBanner").textContent = "Verification iMessage sent. Reply “hi” to activate posture alerts.";
    $("activateBanner").classList.toggle("hidden", Boolean(user?.activated));
    return flash(result.returning ? "Welcome-back iMessage sent." : "Verification iMessage sent. Reply “hi” to activate alerts.", 6000);
  }
  if (delivery.status === "pending-allow-list") {
    $("activateBanner").textContent = "This number is pending the Photon project allow-list. Add it there, then sign in again.";
    $("activateBanner").classList.remove("hidden");
    return flash("iMessage pending: add this number to the Photon project allow-list.", 7000);
  }
  const detail = delivery.detail || deliveryReason(delivery.reason);
  $("activateBanner").textContent = `Verification iMessage failed: ${detail}`;
  $("activateBanner").classList.remove("hidden");
  flash(`iMessage failed: ${detail}`, 7000);
}
async function calibrate() {
  mode = "calibrating"; samples = [];
  flash(`Sit upright and hold still for ${CALIBRATION_SECONDS} seconds`, CALIBRATION_SECONDS * 1000);
  await new Promise((resolve) => setTimeout(resolve, CALIBRATION_SECONDS * 1000));
  if (samples.length < 20) { mode = "idle"; flash("We could not see your head and shoulders clearly.", 5000); return false; }
  baseline = {};
  for (const key of Object.keys(samples[0])) {
    const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    baseline[key] = values[Math.floor(values.length / 2)];
  }
  baseline.calibratedAt = new Date().toISOString();
  localStorage.setItem(`posturepal.baseline.${user.id}`, JSON.stringify(baseline));
  $("calibInfo").textContent = `Calibrated ${new Date().toLocaleString()}`;
  return true;
}
async function start() {
  $("startBtn").disabled = true;
  try {
    await initializePose(); await cameraOn();
    lastFrame = 0; frame = requestAnimationFrame(loop);
    if (!baseline && !(await calibrate())) return stop(false);
    stats = freshStats(); smooth = null; badStreak = 0; goodStreak = 0; alerted = false; sessionStart = Date.now();
    $("alerts").textContent = "0"; mode = "tracking";
    $("stopBtn").disabled = false; $("calibrateBtn").disabled = false;
    await post("/api/session/start", {
      slouchSeconds: Number($("slouchSeconds").value),
      sensitivity: $("sensitivity").value,
      voiceId: $("voiceId").value,
      audioEnabled: $("audioEnabled").checked,
    });
    heartbeat = setInterval(async () => {
      const result = await post("/api/heartbeat", { stats: roundedStats() }).catch(() => ({}));
      if (result.stop) void stop();
    }, 10000);
  } catch (error) {
    flash(`Could not start: ${error.message}`, 5000);
    stop(false);
  }
}
async function stop(report = true) {
  const tracked = mode === "tracking";
  mode = "idle"; clearInterval(heartbeat); cameraOff(); status("Not tracking");
  $("startBtn").disabled = false; $("stopBtn").disabled = true; $("calibrateBtn").disabled = true;
  $("debriefPanel")?.classList.add("hidden");
  if (report && tracked) {
    const result = await post("/api/session/stop", { stats: roundedStats() }).catch(() => null);
    if (result?.debrief) renderDebrief(result.debrief, result.recap);
    if (result?.recap) {
      flash(`Session recap · ${result.recap}`, 9000);
      await speak({ message: result.recap, audioUrl: result.audioUrl });
    }
  }
}

function renderDebrief(debrief, recapText) {
  const panel = $("debriefPanel");
  const list = $("debriefList");
  if (!panel || !list || !debrief) return;
  const comparison = debrief.comparison === "first_session"
    ? "First PosturePal session — no lifetime average yet"
    : debrief.comparison === "equal"
      ? `Matches lifetime average (${debrief.lifetimeUprightPct}% upright)`
      : debrief.comparison === "higher"
        ? `${debrief.deltaPct} pts above lifetime avg (${debrief.lifetimeUprightPct}%)`
        : `${debrief.deltaPct} pts below lifetime avg (${debrief.lifetimeUprightPct}%)`;
  list.innerHTML = [
    ["Session length", `${debrief.minutes} min`],
    ["Nudges sent", String(debrief.nudges)],
    ["Upright this session", `${debrief.uprightPct}%`],
    ["Vs lifetime average", comparison],
  ].map(([label, value]) => `<li><span>${label}</span><strong>${value}</strong></li>`).join("");
  const recap = $("debriefRecap");
  if (recap) recap.textContent = recapText || "";
  panel.classList.remove("hidden");
}

$("signupForm").onsubmit = async (event) => {
  event.preventDefault(); $("signupBtn").disabled = true; $("signupError").classList.add("hidden");
  const form = new FormData(event.target);
  try {
    const result = await post("/api/signup", {
      firstName: form.get("firstName"), lastName: form.get("lastName"),
      phone: form.get("phone"), consent: form.get("consent") === "on",
    });
    user = result.user; saveUser(); showView();
    applySettings(result.settings);
    showWelcomeDelivery(result);
  } catch (error) {
    $("signupError").textContent = error.message; $("signupError").classList.remove("hidden");
  } finally { $("signupBtn").disabled = false; }
};
$("signOutBtn").onclick = async () => { await stop(); user = null; baseline = null; saveUser(); showView(); };
$("startBtn").onclick = start;
$("stopBtn").onclick = () => stop();
$("calibrateBtn").onclick = async () => { const previous = mode; if (await calibrate()) smooth = null; mode = previous; };
$("testBtn").onclick = async () => {
  try {
    const result = await post("/api/alert", { test: true });
    await speak(result);
    flash(result.sent ? "Test iMessage sent." : `Voice test played; iMessage not sent: ${deliveryReason(result.reason)}`, 6000);
  }
  catch (error) { flash(error.message); }
};
$("slouchSeconds").oninput = () => { $("slouchOutput").value = `${$("slouchSeconds").value} sec`; localStorage.setItem("posturepal.slouchSeconds", $("slouchSeconds").value); };
$("slouchSeconds").onchange = saveSettings;
$("sensitivity").onchange = saveSettings;
$("voiceId").onchange = saveSettings;
$("audioEnabled").onchange = saveSettings;
$("slouchSeconds").value = localStorage.getItem("posturepal.slouchSeconds") || "30";
$("slouchSeconds").oninput();
window.addEventListener("beforeunload", () => mode === "tracking" && navigator.sendBeacon("/api/session/stop", JSON.stringify({ userId: user.id, stats: roundedStats() })));

function initHeroCanvas() {
  const canvas = document.getElementById("heroCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let frame = 0;
  const joints = [
    [0.5, 0.16], [0.5, 0.28], [0.38, 0.34], [0.62, 0.34], [0.32, 0.48], [0.68, 0.48],
    [0.28, 0.62], [0.72, 0.62], [0.42, 0.52], [0.58, 0.52], [0.46, 0.78], [0.54, 0.78],
    [0.44, 0.94], [0.56, 0.94],
  ];
  const edges = [[0, 1], [1, 2], [1, 3], [2, 4], [3, 5], [4, 6], [5, 7], [2, 8], [3, 9], [8, 10], [9, 11], [10, 12], [11, 13], [8, 9]];
  const draw = () => {
    frame += 1;
    const wobble = Math.sin(frame * 0.04) * 0.012;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#060708";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < canvas.height; y += 12) {
      for (let x = 0; x < canvas.width; x += 12) {
        ctx.fillStyle = "rgba(224, 177, 90, 0.05)";
        ctx.fillRect(x, y, 1, 1);
      }
    }
    const points = joints.map(([x, y], index) => {
      const slump = index < 4 ? wobble * 2.5 : wobble;
      return { x: (x + slump) * canvas.width, y: (y + slump * 0.4) * canvas.height };
    });
    ctx.strokeStyle = "rgba(224, 177, 90, 0.55)";
    ctx.lineWidth = 1;
    edges.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(points[a].x, points[a].y);
      ctx.lineTo(points[b].x, points[b].y);
      ctx.stroke();
    });
    points.forEach((point, index) => {
      ctx.beginPath();
      ctx.fillStyle = index === 0 ? "#e0b15a" : "rgba(201, 162, 88, 0.75)";
      ctx.arc(point.x, point.y, index === 0 ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    requestAnimationFrame(draw);
  };
  draw();
}

initHeroCanvas();
showView();
verifyUser();
