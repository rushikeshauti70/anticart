import React from 'react';

export function TrolleyVisualizer({
  telemetry,
  status,
  connection = 'offline',
  lastSeen = null,
  isSimulated = false,
}) {
  const isOnline = connection === 'online';
  const isStale = connection === 'stale';

  // Sensor extraction with fallback defaults
  const mode = telemetry?.mode || (status?.motorsEnabled ? 'LINE_FOLLOW' : 'PAUSED');
  const distanceCm = telemetry?.ultrasonic?.distance_cm ?? 400;
  const servoAngle = telemetry?.ultrasonic?.servo_angle_deg ?? 90;
  const isValid = telemetry?.ultrasonic?.valid ?? true;
  const obstacle = Boolean(telemetry?.obstacle);
  const ir = telemetry?.ir || { left: false, center: false, right: false };

  // Servo rotation: 90 is center (0 deg rotation), 150 is left (-60 deg), 30 is right (+60 deg)
  const rotationDeg = -(servoAngle - 90);

  // Beam radius mapping: 0 to 400cm -> 30px to 110px
  const beamRadius = Math.max(30, Math.min(110, (distanceCm / 400) * 110));

  // Beam color: danger <30cm or obstacle; warning yellow <70cm; sky blue clear
  let beamColor = 'var(--primary)';
  let beamFill = 'rgba(56, 189, 248, 0.22)';
  if (obstacle || distanceCm < 30) {
    beamColor = 'var(--danger)';
    beamFill = 'rgba(220, 38, 38, 0.28)';
  } else if (distanceCm < 70) {
    beamColor = 'var(--accent-dark)';
    beamFill = 'rgba(250, 204, 21, 0.32)';
  }

  // Track horizontal position based on IR sensor readings
  let trackOffset = 0;
  if (ir.left && !ir.right) trackOffset = -14;
  else if (ir.right && !ir.left) trackOffset = 14;

  const formattedTime = lastSeen
    ? new Date(lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className="svg-visualizer-card" style={{ position: 'relative' }}>
      {/* Top Banner indicating status / simulation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className={`pill-dot status-${connection}`} />
          <span style={{ fontSize: '0.82rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {connection}
          </span>
          {isSimulated && (
            <span style={{
              fontSize: '0.7rem',
              backgroundColor: 'var(--accent-soft)',
              color: 'var(--accent-dark)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-sm)',
              fontWeight: 600
            }}>
              SIMULATION MODE
            </span>
          )}
        </div>
        {(!isOnline && formattedTime) && (
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Last update: {formattedTime}
          </span>
        )}
      </div>

      {/* SVG Canvas */}
      <svg
        className="svg-canvas"
        viewBox="0 0 400 420"
        style={{
          filter: isOnline ? 'none' : 'grayscale(80%) opacity(0.75)',
          transition: 'filter 0.3s ease',
        }}
        aria-label="Trolley Top-Down Hardware Visualizer"
      >
        <defs>
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* 1. Floor Line Strip (Yellow line beneath trolley, shifting with IR) */}
        <line
          x1={200 + trackOffset}
          y1="10"
          x2={200 + trackOffset}
          y2="410"
          stroke="var(--accent)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray="16 10"
          opacity="0.9"
          style={{ transition: 'x1 0.25s ease, x2 0.25s ease' }}
        />

        {/* 2. Trolley Wheels (4 black rubber tires) */}
        {/* Front Left */}
        <rect x="124" y="160" width="14" height="38" rx="4" fill="#1E293B" stroke="#0F172A" strokeWidth="1" />
        {/* Front Right */}
        <rect x="262" y="160" width="14" height="38" rx="4" fill="#1E293B" stroke="#0F172A" strokeWidth="1" />
        {/* Rear Left */}
        <rect x="124" y="270" width="14" height="38" rx="4" fill="#1E293B" stroke="#0F172A" strokeWidth="1" />
        {/* Rear Right */}
        <rect x="262" y="270" width="14" height="38" rx="4" fill="#1E293B" stroke="#0F172A" strokeWidth="1" />

        {/* 3. Chassis Body */}
        <rect
          x="138"
          y="140"
          width="124"
          height="185"
          rx="12"
          fill="#FFFFFF"
          stroke={obstacle ? 'var(--danger)' : 'var(--border)'}
          strokeWidth={obstacle ? '3' : '2'}
          style={{
            transition: 'stroke 0.2s ease, stroke-width 0.2s ease',
            filter: obstacle ? 'url(#glow)' : 'drop-shadow(0 2px 4px rgba(15,23,42,0.06))',
          }}
        />

        {/* Front Bump Edge Indicator */}
        <path d="M 148 140 Q 200 134 252 140" fill="none" stroke="var(--primary-dark)" strokeWidth="2.5" />

        {/* 4. Three Front IR Sensors (Mounted at FRONT underside: Left, Center, Right) */}
        <g id="front-ir-sensors">
          {/* Left IR */}
          <circle
            cx="175"
            cy="152"
            r="5"
            fill={ir.left ? 'var(--primary-dark)' : '#FFFFFF'}
            stroke="var(--primary-dark)"
            strokeWidth="1.5"
            style={{ transition: 'fill 0.15s ease' }}
          />
          {/* Center IR */}
          <circle
            cx="200"
            cy="152"
            r="5"
            fill={ir.center ? 'var(--primary-dark)' : '#FFFFFF'}
            stroke="var(--primary-dark)"
            strokeWidth="1.5"
            style={{ transition: 'fill 0.15s ease' }}
          />
          {/* Right IR */}
          <circle
            cx="225"
            cy="152"
            r="5"
            fill={ir.right ? 'var(--primary-dark)' : '#FFFFFF'}
            stroke="var(--primary-dark)"
            strokeWidth="1.5"
            style={{ transition: 'fill 0.15s ease' }}
          />
        </g>

        {/* 5. Center ESP32 Microcontroller Board */}
        <rect x="170" y="215" width="60" height="50" rx="4" fill="#0F172A" stroke="#334155" strokeWidth="1" />
        <text
          x="200"
          y="244"
          textAnchor="middle"
          fill="#F8FAFC"
          fontSize="10"
          fontWeight="700"
          fontFamily="monospace"
          letterSpacing="0.06em"
        >
          ESP32
        </text>
        {/* Microcontroller solder pin details */}
        <line x1="166" y1="223" x2="170" y2="223" stroke="#94A3B8" strokeWidth="2" />
        <line x1="166" y1="233" x2="170" y2="233" stroke="#94A3B8" strokeWidth="2" />
        <line x1="166" y1="243" x2="170" y2="243" stroke="#94A3B8" strokeWidth="2" />
        <line x1="166" y1="253" x2="170" y2="253" stroke="#94A3B8" strokeWidth="2" />
        <line x1="230" y1="223" x2="234" y2="223" stroke="#94A3B8" strokeWidth="2" />
        <line x1="230" y1="233" x2="234" y2="233" stroke="#94A3B8" strokeWidth="2" />
        <line x1="230" y1="243" x2="234" y2="243" stroke="#94A3B8" strokeWidth="2" />
        <line x1="230" y1="253" x2="234" y2="253" stroke="#94A3B8" strokeWidth="2" />

        {/* Status LED on board */}
        <circle
          cx="218"
          cy="224"
          r="2.5"
          fill={isOnline ? 'var(--primary)' : 'var(--danger)'}
        />

        {/* 6. Rotating Ultrasonic Sensor (HC-SR04) + Radar Fan Beam */}
        <g
          transform={`rotate(${rotationDeg}, 200, 130)`}
          style={{ transition: 'transform 0.25s ease-out' }}
        >
          {/* Radar Fan Beam */}
          <path
            d={`M 200 130 L ${200 - Math.tan(16 * Math.PI / 180) * beamRadius} ${130 - beamRadius} A ${beamRadius} ${beamRadius} 0 0 1 ${200 + Math.tan(16 * Math.PI / 180) * beamRadius} ${130 - beamRadius} Z`}
            fill={beamFill}
            stroke={beamColor}
            strokeWidth="1.5"
            strokeDasharray={isValid ? 'none' : '4 3'}
            style={{ transition: 'd 0.25s ease, fill 0.2s ease, stroke 0.2s ease' }}
          />

          {/* Obstacle box at the beam tip if obstacle detected or distance < 30 */}
          {(obstacle || distanceCm < 30) && (
            <g transform={`translate(200, ${130 - Math.max(25, beamRadius)})`}>
              <rect
                x="-14"
                y="-14"
                width="28"
                height="14"
                rx="3"
                fill="var(--danger)"
                stroke="#7F1D1D"
                strokeWidth="1"
              />
              <text x="0" y="-4" textAnchor="middle" fill="#FFFFFF" fontSize="8" fontWeight="bold">
                BLOCKED
              </text>
            </g>
          )}

          {/* Servo Pivot & HC-SR04 Sensor Head */}
          {/* Servo Base Horn */}
          <rect x="194" y="126" width="12" height="10" rx="2" fill="#475569" />
          {/* Blue Sensor PCB */}
          <rect x="180" y="118" width="40" height="14" rx="2" fill="#0284C7" stroke="#0369A1" strokeWidth="1" />
          {/* Left Transducer Cylinder */}
          <circle cx="188" cy="125" r="4.5" fill="#E2E8F0" stroke="#64748B" strokeWidth="1" />
          <circle cx="188" cy="125" r="2" fill="#94A3B8" />
          {/* Right Transducer Cylinder */}
          <circle cx="212" cy="125" r="4.5" fill="#E2E8F0" stroke="#64748B" strokeWidth="1" />
          <circle cx="212" cy="125" r="2" fill="#94A3B8" />
        </g>
      </svg>
    </div>
  );
}
