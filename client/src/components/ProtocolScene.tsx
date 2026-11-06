import { Float, Html, QuadraticBezierLine, RoundedBox } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type Palette = {
  surface: string;
  surface2: string;
  ink: string;
  navy: string;
  blue: string;
  walnut: string;
  ochre: string;
  terminal: string;
};

const readPalette = (): Palette => {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    surface: read("--surface", "#fffdf8"),
    surface2: read("--surface-2", "#f8f4ed"),
    ink: read("--ink", "#202e3d"),
    navy: read("--navy", "#245573"),
    blue: read("--blue", "#5c97b4"),
    walnut: read("--walnut", "#775034"),
    ochre: read("--ochre", "#b9823d"),
    terminal: read("--terminal-bg", "#141a26"),
  };
};

export function ProtocolScene() {
  const reduceMotion = useReducedMotion() ?? false;
  const [palette, setPalette] = useState(readPalette);

  useEffect(() => {
    const updatePalette = () => setPalette(readPalette());
    const observer = new MutationObserver(updatePalette);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    updatePalette();
    return () => observer.disconnect();
  }, []);

  return (
    <div className="protocol-stage">
      <Canvas
        className="protocol-canvas"
        camera={{ position: [0, 8, 15], fov: 36 }}
        dpr={[1, 1.5]}
        shadows
        fallback={<ProtocolStaticFallback />}
      >
        <ProtocolSceneContent palette={palette} motionEnabled={!reduceMotion} />
      </Canvas>
    </div>
  );
}

function ProtocolSceneContent({ palette, motionEnabled }: { palette: Palette; motionEnabled: boolean }) {
  const { size, camera } = useThree();
  const mobile = size.width <= 820;

  useEffect(() => {
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    perspectiveCamera.position.set(0, mobile ? 17 : 8, mobile ? 13 : 15);
    perspectiveCamera.fov = mobile ? 31 : 36;
    perspectiveCamera.lookAt(0, mobile ? 0.9 : 1, 0);
    perspectiveCamera.updateProjectionMatrix();
  }, [camera, mobile]);

  const leftPosition: [number, number, number] = mobile ? [0, 0, -5.3] : [-7.8, 0, 0];
  const rightPosition: [number, number, number] = mobile ? [0, 0, 5.3] : [7.8, 0, 0];
  const laptopScale = mobile ? 0.69 : 0.94;
  const mobileViewWidth = 2 * Math.tan(31 * Math.PI / 360) * Math.hypot(16.1, 13) * size.width / Math.max(size.height, 1);
  const terminalWidth = mobile ? Math.min(5.8, Math.max(4.8, mobileViewWidth * 0.92)) : 5.8;
  const curve = useMemo(() => {
    const start = mobile ? new THREE.Vector3(0, 1.43, -5.62) : new THREE.Vector3(-6.56, 1.46, -0.32);
    const end = mobile ? new THREE.Vector3(0, 1.43, 4.98) : new THREE.Vector3(6.56, 1.46, -0.32);
    const control = mobile ? new THREE.Vector3(0, 3.72, -0.5) : new THREE.Vector3(0, 3.72, -0.62);
    return { start, end, control, path: new THREE.QuadraticBezierCurve3(start, control, end) };
  }, [mobile]);
  const midpoint = curve.path.getPoint(0.5);
  const cardPosition: [number, number, number] = [midpoint.x, midpoint.y, midpoint.z + 0.72];
  const leftLabel: [number, number, number] = mobile ? [0, -0.24, -6.45] : [-7.8, -0.3, 2.2];
  const rightLabel: [number, number, number] = mobile ? [0, -0.24, 6.35] : [7.8, -0.3, 2.2];

  return (
    <>
      <ambientLight intensity={1.1} />
      <directionalLight position={[-3, 9, 7]} intensity={2.1} castShadow shadow-mapSize={[1024, 1024]} />
      <pointLight position={[0, 4, 1]} color={palette.blue} intensity={1.4} distance={13} />
      <Laptop position={leftPosition} scale={laptopScale} yaw={0.16} phase={0} palette={palette} motionEnabled={motionEnabled} />
      <Laptop position={rightPosition} scale={laptopScale} yaw={-0.16} phase={Math.PI} palette={palette} motionEnabled={motionEnabled} />
      <QuadraticBezierLine
        start={curve.start.toArray()}
        end={curve.end.toArray()}
        mid={curve.control.toArray()}
        color={palette.blue}
        lineWidth={7}
        transparent
        opacity={0.13}
        depthWrite={false}
      />
      <QuadraticBezierLine
        start={curve.start.toArray()}
        end={curve.end.toArray()}
        mid={curve.control.toArray()}
        color={palette.blue}
        lineWidth={1.8}
        transparent
        opacity={0.94}
        depthWrite={false}
      />
      <ArcParticles curve={curve.path} color={palette.ochre} motionEnabled={motionEnabled} />
      <WorkerLabel position={leftLabel} worker="Worker A" action="Stores in Arkiv" />
      <WorkerLabel position={rightLabel} worker="Worker B" action="Takes from Arkiv" />
      <EscrowTransactionBox position={cardPosition} width={terminalWidth} palette={palette} motionEnabled={motionEnabled} />
    </>
  );
}

function Laptop({ position, scale, yaw, phase, palette, motionEnabled }: {
  position: [number, number, number];
  scale: number;
  yaw: number;
  phase: number;
  palette: Palette;
  motionEnabled: boolean;
}) {
  const laptop = useRef<THREE.Group>(null);

  useFrame(({ clock }) => {
    if (laptop.current && motionEnabled) {
      laptop.current.rotation.y = yaw + Math.sin(clock.elapsedTime * 0.62 + phase) * 0.075;
    }
  });

  return (
    <group ref={laptop} position={position} scale={scale} rotation={[0, yaw, 0]}>
      <mesh position={[0, 0.11, 0]} receiveShadow castShadow>
        <cylinderGeometry args={[1.95, 1.95, 0.18, 64]} />
        <meshStandardMaterial color={palette.surface} metalness={0.32} roughness={0.42} />
      </mesh>
      <mesh position={[0, 0.205, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.78, 0.018, 8, 72]} />
        <meshBasicMaterial color={palette.walnut} transparent opacity={0.5} />
      </mesh>
      <mesh position={[0, 0.213, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.9, 0.014, 8, 72]} />
        <meshBasicMaterial color={palette.blue} transparent opacity={0.4} />
      </mesh>

      <RoundedBox args={[2.7, 0.13, 1.74]} radius={0.12} smoothness={5} position={[0, 0.27, 0.38]} castShadow receiveShadow>
        <meshStandardMaterial color={palette.surface2} metalness={0.45} roughness={0.32} />
      </RoundedBox>
      <RoundedBox args={[2.52, 0.025, 1.57]} radius={0.09} smoothness={4} position={[0, 0.34, 0.38]}>
        <meshStandardMaterial color={palette.surface} roughness={0.42} />
      </RoundedBox>
      <mesh position={[0, 0.405, -0.47]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.045, 0.045, 2.52, 18]} />
        <meshStandardMaterial color={palette.walnut} metalness={0.45} roughness={0.3} />
      </mesh>
      <RoundedBox args={[2.64, 1.78, 0.13]} radius={0.11} smoothness={5} position={[0, 1.34, -0.48]} castShadow>
        <meshStandardMaterial color={palette.navy} metalness={0.55} roughness={0.28} />
      </RoundedBox>
      <RoundedBox args={[2.4, 1.54, 0.018]} radius={0.065} smoothness={4} position={[0, 1.34, -0.405]}>
        <meshBasicMaterial color={palette.terminal} />
      </RoundedBox>
      <ScreenReadout palette={palette} motionEnabled={motionEnabled} />
      <Keyboard palette={palette} />
      <RoundedBox args={[0.55, 0.018, 0.34]} radius={0.045} smoothness={4} position={[0, 0.368, 0.94]}>
        <meshStandardMaterial color={palette.surface} metalness={0.2} roughness={0.55} />
      </RoundedBox>
      <mesh position={[0, 0.365, 0.94]}>
        <boxGeometry args={[0.34, 0.004, 0.006]} />
        <meshBasicMaterial color={palette.blue} transparent opacity={0.55} />
      </mesh>
      <RoundedBox args={[0.25, 0.022, 0.045]} radius={0.018} smoothness={3} position={[0, 0.34, 1.235]}>
        <meshStandardMaterial color={palette.walnut} metalness={0.4} roughness={0.3} />
      </RoundedBox>
    </group>
  );
}

function Keyboard({ palette }: { palette: Palette }) {
  return (
    <group>
      {Array.from({ length: 40 }, (_, index) => {
        const column = index % 8;
        const row = Math.floor(index / 8);
        return (
          <RoundedBox
            key={index}
            args={[0.185, 0.022, 0.105]}
            radius={0.018}
            smoothness={2}
            position={[(column - 3.5) * 0.225, 0.365, 0.05 + row * 0.145]}
          >
            <meshStandardMaterial color={palette.ink} transparent opacity={0.18} roughness={0.55} />
          </RoundedBox>
        );
      })}
    </group>
  );
}

function ScreenReadout({ palette, motionEnabled }: { palette: Palette; motionEnabled: boolean }) {
  const bars = useRef<(THREE.Mesh | null)[]>([]);
  const entries = [
    { x: -0.72, y: 1.78, width: 1.15, color: palette.blue },
    { x: -0.72, y: 1.51, width: 0.78, color: palette.ochre },
    { x: -0.72, y: 1.24, width: 1.34, color: palette.blue },
    { x: -0.72, y: 0.97, width: 0.92, color: palette.walnut },
  ];

  useFrame(({ clock }) => {
    if (!motionEnabled) return;
    bars.current.forEach((bar, index) => {
      const material = bar?.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = 0.66 + Math.sin(clock.elapsedTime * 2.1 + index * 1.7) * 0.2;
      }
    });
  });

  return (
    <group>
      {entries.map((entry, index) => (
        <mesh
          key={index}
          ref={(mesh) => { bars.current[index] = mesh; }}
          position={[entry.x + entry.width / 2, entry.y, -0.391]}
        >
          <planeGeometry args={[entry.width, 0.045]} />
          <meshBasicMaterial color={entry.color} transparent opacity={0.75} toneMapped={false} />
        </mesh>
      ))}
      <mesh position={[0.74, 0.74, -0.391]}>
        <circleGeometry args={[0.045, 16]} />
        <meshBasicMaterial color={palette.ochre} toneMapped={false} />
      </mesh>
    </group>
  );
}

function ArcParticles({ curve, color, motionEnabled }: { curve: THREE.QuadraticBezierCurve3; color: string; motionEnabled: boolean }) {
  const particles = useRef<(THREE.Group | null)[]>([]);
  useFrame(({ clock }) => {
    const offset = motionEnabled ? clock.elapsedTime * 0.055 : 0;
    particles.current.forEach((particle, index) => {
      if (!particle) return;
      const progress = motionEnabled ? (offset + index / 4) % 1 : 0.18 + index * 0.21;
      particle.position.copy(curve.getPoint(progress));
    });
  });

  return (
    <>
      {Array.from({ length: 4 }, (_, index) => (
        <group key={index} ref={(particle) => { particles.current[index] = particle; }}>
          <mesh>
            <sphereGeometry args={[0.052, 14, 14]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
          <mesh scale={2.2}>
            <sphereGeometry args={[0.052, 12, 12]} />
            <meshBasicMaterial color={color} transparent opacity={0.17} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>
  );
}

function EscrowTransactionBox({ position, width, palette, motionEnabled }: { position: [number, number, number]; width: number; palette: Palette; motionEnabled: boolean }) {
  return (
    <Float speed={0.65} floatIntensity={motionEnabled ? 0.1 : 0} rotationIntensity={0} floatingRange={[-0.08, 0.08]}>
      <group position={position}>
        <RoundedBox args={[width, 1.1, 0.5]} radius={0.12} smoothness={5} castShadow receiveShadow>
          <meshStandardMaterial color={palette.surface2} metalness={0.48} roughness={0.32} />
        </RoundedBox>
        <RoundedBox args={[width - 0.45, 0.86, 0.025]} radius={0.075} smoothness={4} position={[0, 0, 0.265]}>
          <meshBasicMaterial color={palette.terminal} />
        </RoundedBox>
        <Html center position={[0, 0, 0.28]} zIndexRange={[100, 0]} pointerEvents="none">
          <div className="protocol-ledger-label">
            <span className="protocol-ledger-status">ARKIV STORED</span>
            <span className="protocol-ledger-status">ESCROW TX ACCEPTED</span>
          </div>
        </Html>
      </group>
    </Float>
  );
}

function WorkerLabel({ position, worker, action }: { position: [number, number, number]; worker: string; action: string }) {
  return (
    <Html center position={position} zIndexRange={[20, 0]} pointerEvents="none">
      <div className="protocol-party">
        <strong>{worker}</strong>
        <span className="protocol-detail">{action}</span>
      </div>
    </Html>
  );
}

function ProtocolStaticFallback() {
  return (
    <div className="protocol-static">
      <svg className="protocol-static-arc protocol-static-arc-wide" viewBox="0 0 1000 430" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 110 285 Q 500 0 890 285" />
      </svg>
      <svg className="protocol-static-arc protocol-static-arc-mobile" viewBox="0 0 360 640" preserveAspectRatio="none" aria-hidden="true">
        <path d="M 180 88 Q 325 320 180 552" />
      </svg>
      <StaticWorker side="a" worker="Worker A" action="Stores in Arkiv" />
      <div className="protocol-static-ledger">
        <span className="protocol-ledger-status">ARKIV STORED</span>
        <span className="protocol-ledger-status">ESCROW TX ACCEPTED</span>
      </div>
      <StaticWorker side="b" worker="Worker B" action="Takes from Arkiv" />
    </div>
  );
}

function StaticWorker({ side, worker, action }: { side: "a" | "b"; worker: string; action: string }) {
  return (
    <div className={"protocol-static-worker protocol-static-worker-" + side}>
      <div className="protocol-static-laptop" aria-hidden="true">
        <div className="protocol-static-screen"><i /><i /><i /></div>
        <div className="protocol-static-base"><span /><span /><span /><span /><span /><span /></div>
      </div>
      <strong>{worker}</strong>
      <span className="protocol-detail">{action}</span>
    </div>
  );
}
