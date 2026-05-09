/**
 * VoicePoweredOrb — animated WebGL orb that reacts to voice level + state.
 *
 * Adapted from the user-supplied OGL shader. Two important changes from
 * the original:
 *
 *   1. **No internal getUserMedia.** The original component opened its
 *      own mic to drive animations, but we already have a mic open via
 *      `useMicCapture` (the canonical capture for transcription). Two
 *      independent streams = AGC inconsistencies, double-permission
 *      prompts, and battery drain. We accept a `voiceLevel` prop (0-1)
 *      from the parent instead and let the parent compute it once.
 *
 *   2. **State-driven hue + rotation.** The orb reads a `state` prop
 *      and shifts hue / rotation speed to convey what the agent is
 *      doing without any text:
 *        - listening → blue / cool, gentle rotation, voice-reactive
 *        - thinking  → amber / yellow, faster rotation, no voice
 *        - speaking  → green / cyan, energetic, oscillating intensity
 *        - idle      → soft purple, very slow rotation
 *
 * The shader itself is unchanged — only the JS driver around it.
 */
import * as React from "react"
import { Renderer, Program, Mesh, Triangle, Vec3 } from "ogl"

import { cn } from "@/lib/utils"

export type OrbState = "idle" | "listening" | "thinking" | "speaking"

export interface VoicePoweredOrbProps {
  className?: string
  /** Agent state; drives hue + animation speed. */
  state?: OrbState
  /** User voice activity level in [0, 1]. Drives the hover intensity
   *  and rotation kick when state="listening". Pass 0 when not
   *  listening. */
  voiceLevel?: number
  /** Override the default hue (0-360 deg). Use only when you need a
   *  custom palette; normally the state mapping is what you want. */
  hueOverride?: number | null
}

const VERT = /* glsl */ `
    precision highp float;
    attribute vec2 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `

const FRAG = /* glsl */ `
    precision highp float;

    uniform float iTime;
    uniform vec3 iResolution;
    uniform float hue;
    uniform float hover;
    uniform float rot;
    uniform float hoverIntensity;
    varying vec2 vUv;

    vec3 rgb2yiq(vec3 c) {
      float y = dot(c, vec3(0.299, 0.587, 0.114));
      float i = dot(c, vec3(0.596, -0.274, -0.322));
      float q = dot(c, vec3(0.211, -0.523, 0.312));
      return vec3(y, i, q);
    }

    vec3 yiq2rgb(vec3 c) {
      float r = c.x + 0.956 * c.y + 0.621 * c.z;
      float g = c.x - 0.272 * c.y - 0.647 * c.z;
      float b = c.x - 1.106 * c.y + 1.703 * c.z;
      return vec3(r, g, b);
    }

    vec3 adjustHue(vec3 color, float hueDeg) {
      float hueRad = hueDeg * 3.14159265 / 180.0;
      vec3 yiq = rgb2yiq(color);
      float cosA = cos(hueRad);
      float sinA = sin(hueRad);
      float i = yiq.y * cosA - yiq.z * sinA;
      float q = yiq.y * sinA + yiq.z * cosA;
      yiq.y = i;
      yiq.z = q;
      return yiq2rgb(yiq);
    }

    vec3 hash33(vec3 p3) {
      p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
      p3 += dot(p3, p3.yxz + 19.19);
      return -1.0 + 2.0 * fract(vec3(
        p3.x + p3.y,
        p3.x + p3.z,
        p3.y + p3.z
      ) * p3.zyx);
    }

    float snoise3(vec3 p) {
      const float K1 = 0.333333333;
      const float K2 = 0.166666667;
      vec3 i = floor(p + (p.x + p.y + p.z) * K1);
      vec3 d0 = p - (i - (i.x + i.y + i.z) * K2);
      vec3 e = step(vec3(0.0), d0 - d0.yzx);
      vec3 i1 = e * (1.0 - e.zxy);
      vec3 i2 = 1.0 - e.zxy * (1.0 - e);
      vec3 d1 = d0 - (i1 - K2);
      vec3 d2 = d0 - (i2 - K1);
      vec3 d3 = d0 - 0.5;
      vec4 h = max(0.6 - vec4(
        dot(d0, d0),
        dot(d1, d1),
        dot(d2, d2),
        dot(d3, d3)
      ), 0.0);
      vec4 n = h * h * h * h * vec4(
        dot(d0, hash33(i)),
        dot(d1, hash33(i + i1)),
        dot(d2, hash33(i + i2)),
        dot(d3, hash33(i + 1.0))
      );
      return dot(vec4(31.316), n);
    }

    vec4 extractAlpha(vec3 colorIn) {
      float a = max(max(colorIn.r, colorIn.g), colorIn.b);
      return vec4(colorIn.rgb / (a + 1e-5), a);
    }

    const vec3 baseColor1 = vec3(0.611765, 0.262745, 0.996078);
    const vec3 baseColor2 = vec3(0.298039, 0.760784, 0.913725);
    const vec3 baseColor3 = vec3(0.062745, 0.078431, 0.600000);
    const float innerRadius = 0.6;
    const float noiseScale = 0.65;

    float light1(float intensity, float attenuation, float dist) {
      return intensity / (1.0 + dist * attenuation);
    }
    float light2(float intensity, float attenuation, float dist) {
      return intensity / (1.0 + dist * dist * attenuation);
    }

    vec4 draw(vec2 uv) {
      vec3 color1 = adjustHue(baseColor1, hue);
      vec3 color2 = adjustHue(baseColor2, hue);
      vec3 color3 = adjustHue(baseColor3, hue);

      float ang = atan(uv.y, uv.x);
      float len = length(uv);
      float invLen = len > 0.0 ? 1.0 / len : 0.0;

      float n0 = snoise3(vec3(uv * noiseScale, iTime * 0.5)) * 0.5 + 0.5;
      float r0 = mix(mix(innerRadius, 1.0, 0.4), mix(innerRadius, 1.0, 0.6), n0);
      float d0 = distance(uv, (r0 * invLen) * uv);
      float v0 = light1(1.0, 10.0, d0);
      v0 *= smoothstep(r0 * 1.05, r0, len);
      float cl = cos(ang + iTime * 2.0) * 0.5 + 0.5;

      float a = iTime * -1.0;
      vec2 pos = vec2(cos(a), sin(a)) * r0;
      float d = distance(uv, pos);
      float v1 = light2(1.5, 5.0, d);
      v1 *= light1(1.0, 50.0, d0);

      float v2 = smoothstep(1.0, mix(innerRadius, 1.0, n0 * 0.5), len);
      float v3 = smoothstep(innerRadius, mix(innerRadius, 1.0, 0.5), len);

      vec3 col = mix(color1, color2, cl);
      col = mix(color3, col, v0);
      col = (col + v1) * v2 * v3;
      col = clamp(col, 0.0, 1.0);

      return extractAlpha(col);
    }

    vec4 mainImage(vec2 fragCoord) {
      vec2 center = iResolution.xy * 0.5;
      float size = min(iResolution.x, iResolution.y);
      vec2 uv = (fragCoord - center) / size * 2.0;

      float angle = rot;
      float s = sin(angle);
      float c = cos(angle);
      uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

      uv.x += hover * hoverIntensity * 0.1 * sin(uv.y * 10.0 + iTime);
      uv.y += hover * hoverIntensity * 0.1 * sin(uv.x * 10.0 + iTime);

      return draw(uv);
    }

    void main() {
      vec2 fragCoord = vUv * iResolution.xy;
      vec4 col = mainImage(fragCoord);
      gl_FragColor = vec4(col.rgb * col.a, col.a);
    }
  `

// State → (hue offset, base rotation speed, base hover intensity).
// Hue is in degrees, applied on top of the shader's base palette.
const STATE_PROFILE: Record<OrbState, {
  hue: number
  rot: number
  hover: number
}> = {
  idle:      { hue: 0,    rot: 0.10, hover: 0.05 },
  listening: { hue: 200,  rot: 0.25, hover: 0.40 },  // cool blue
  thinking:  { hue: 40,   rot: 0.80, hover: 0.20 },  // amber, fast
  speaking:  { hue: 110,  rot: 0.55, hover: 0.65 },  // green, energetic
}

export function VoicePoweredOrb({
  className,
  state = "idle",
  voiceLevel = 0,
  hueOverride = null,
}: VoicePoweredOrbProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  // We pass live values to the render loop via a ref so changing props
  // doesn't have to recreate the WebGL context (expensive).
  const liveRef = React.useRef({ state, voiceLevel, hueOverride })
  React.useEffect(() => {
    liveRef.current = { state, voiceLevel, hueOverride }
  }, [state, voiceLevel, hueOverride])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let renderer: Renderer | null = null
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = null
    let raf = 0
    let program: Program | null = null
    let mesh: Mesh | null = null

    try {
      renderer = new Renderer({
        alpha: true,
        premultipliedAlpha: false,
        antialias: true,
        dpr: window.devicePixelRatio || 1,
      })
      gl = renderer.gl
      gl.clearColor(0, 0, 0, 0)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

      // Hot-reload safety: clear any orphaned canvas from a previous mount.
      while (container.firstChild) container.removeChild(container.firstChild)
      container.appendChild(gl.canvas)

      program = new Program(gl, {
        vertex: VERT,
        fragment: FRAG,
        uniforms: {
          iTime: { value: 0 },
          iResolution: {
            value: new Vec3(
              gl.canvas.width,
              gl.canvas.height,
              gl.canvas.width / gl.canvas.height,
            ),
          },
          hue: { value: 0 },
          hover: { value: 0 },
          rot: { value: 0 },
          hoverIntensity: { value: 0 },
        },
      })
      mesh = new Mesh(gl, { geometry: new Triangle(gl), program })
    } catch (err) {
      console.error("[orb] init failed:", err)
      return
    }

    const resize = () => {
      if (!container || !renderer || !gl || !program) return
      const dpr = window.devicePixelRatio || 1
      const w = container.clientWidth
      const h = container.clientHeight
      if (w === 0 || h === 0) return
      renderer.setSize(w * dpr, h * dpr)
      gl.canvas.style.width = `${w}px`
      gl.canvas.style.height = `${h}px`
      program.uniforms.iResolution.value.set(
        gl.canvas.width,
        gl.canvas.height,
        gl.canvas.width / gl.canvas.height,
      )
    }
    window.addEventListener("resize", resize)
    resize()

    let lastT = 0
    let rotAngle = 0
    // Smoothed values — we lerp toward target so state changes don't pop.
    let smoothHue = STATE_PROFILE.idle.hue
    let smoothRotSpeed = STATE_PROFILE.idle.rot
    let smoothHover = 0
    let smoothHoverIntensity = 0

    const tick = (t: number) => {
      raf = requestAnimationFrame(tick)
      if (!program || !renderer || !mesh || !gl) return
      const dt = Math.max(0, (t - lastT) * 0.001)
      lastT = t

      const { state: s, voiceLevel: vl, hueOverride: hueOv } = liveRef.current
      const target = STATE_PROFILE[s]

      // Base targets from state, plus voice modulation when listening.
      const targetHue = hueOv !== null && hueOv !== undefined ? hueOv : target.hue
      // While listening, voice level kicks rotation + hover up.
      const voiceKick = s === "listening" ? Math.min(1, vl) : 0
      const targetRotSpeed = target.rot + voiceKick * 1.2
      // While speaking, oscillate hover intensity for a "pulsing reply" feel.
      const speakOscillator = s === "speaking"
        ? 0.5 + 0.5 * Math.sin(t * 0.005)
        : 1
      const targetHover = (s === "listening" ? voiceKick : speakOscillator) * 1.0
      const targetHoverIntensity =
        target.hover * (s === "listening" ? (0.5 + voiceKick * 0.5) : speakOscillator)

      // Lerp factors — fast for hover (responsive to voice), slow for hue.
      const hueLerp = Math.min(1, dt * 3)
      const fastLerp = Math.min(1, dt * 8)
      const rotLerp = Math.min(1, dt * 4)

      smoothHue += (targetHue - smoothHue) * hueLerp
      smoothRotSpeed += (targetRotSpeed - smoothRotSpeed) * rotLerp
      smoothHover += (targetHover - smoothHover) * fastLerp
      smoothHoverIntensity += (targetHoverIntensity - smoothHoverIntensity) * fastLerp

      rotAngle += dt * smoothRotSpeed

      program.uniforms.iTime.value = t * 0.001
      program.uniforms.hue.value = smoothHue
      program.uniforms.rot.value = rotAngle
      program.uniforms.hover.value = smoothHover
      program.uniforms.hoverIntensity.value = smoothHoverIntensity

      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      renderer.render({ scene: mesh })
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", resize)
      try {
        if (container && gl?.canvas && container.contains(gl.canvas)) {
          container.removeChild(gl.canvas)
        }
      } catch (e) {
        console.warn("[orb] canvas cleanup:", e)
      }
      gl?.getExtension("WEBGL_lose_context")?.loseContext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={containerRef}
      className={cn("relative h-full w-full", className)}
      aria-label="voice orb"
    />
  )
}
