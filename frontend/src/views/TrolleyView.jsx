import React, { useState, useEffect } from 'react';
import { Play, Pause, Square, RotateCw, Activity, AlertTriangle, ShieldCheck } from 'lucide-react';
import { TrolleyVisualizer } from '../components/TrolleyVisualizer';
import { api } from '../api';

export function TrolleyView({
  trolleyState,
  events = [],
  onCommandAck,
}) {
  const [commandInProgress, setCommandInProgress] = useState(false);
  const [commandFeedback, setCommandFeedback] = useState(null);
  const [simulationMode, setSimulationMode] = useState(false);
  const [simTelemetry, setSimTelemetry] = useState(null);

  // Local simulated animation loop when Simulation Mode is toggled
  useEffect(() => {
    if (!simulationMode) {
      setSimTelemetry(null);
      return;
    }

    let angleIdx = 0;
    const angles = [90, 150, 90, 30];
    let distance = 85;
    let uptime = 100;

    const interval = setInterval(() => {
      angleIdx = (angleIdx + 1) % angles.length;
      uptime += 2;
      distance = 45 + Math.sin(uptime) * 40;

      setSimTelemetry({
        mode: 'LINE_FOLLOW',
        ir: {
          left: angles[angleIdx] === 150,
          center: true,
          right: angles[angleIdx] === 30,
        },
        ultrasonic: {
          distance_cm: parseFloat(distance.toFixed(1)),
          servo_angle_deg: angles[angleIdx],
          valid: true,
        },
        obstacle: distance < 30,
        fault: null,
        uptime_s: uptime,
        rssi: -58,
      });
    }, 2000);

    return () => clearInterval(interval);
  }, [simulationMode]);

  const activeTelemetry = simulationMode
    ? simTelemetry
    : (trolleyState?.telemetry || null);

  const activeStatus = simulationMode
    ? { state: 'online', fw: 'v3.0.0-sim', ip: '127.0.0.1', rssi: -58, motorsEnabled: true }
    : (trolleyState?.status || null);

  const activeConnection = simulationMode
    ? 'online'
    : (trolleyState?.connection || 'offline');

  const activeLastSeen = simulationMode
    ? new Date().toISOString()
    : trolleyState?.lastSeen;

  async function handleSendCommand(type) {
    if (simulationMode) {
      setCommandFeedback({
        status: 'executed',
        reason: `Simulation accepted ${type} command`,
        time: new Date().toLocaleTimeString(),
      });
      setTimeout(() => setCommandFeedback(null), 4000);
      return;
    }

    setCommandInProgress(true);
    setCommandFeedback(null);
    try {
      const res = await api.sendTrolleyCommand('trolley-01', type);
      setCommandFeedback({
        status: res.status,
        reason: res.reason,
        time: new Date().toLocaleTimeString(),
      });
      if (onCommandAck) onCommandAck(res);
    } catch (err) {
      setCommandFeedback({
        status: 'error',
        reason: err.message || 'Command failed',
        time: new Date().toLocaleTimeString(),
      });
    } finally {
      setCommandInProgress(false);
      setTimeout(() => setCommandFeedback(null), 6000);
    }
  }

  // Format uptime into mm:ss or hh:mm:ss
  function formatUptime(seconds) {
    if (!seconds && seconds !== 0) return '0s';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  }

  return (
    <div>
      {/* Header & Simulation Toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Trolley Telemetry</h1>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Hardware monitor and motion controller for trolley-01
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={simulationMode}
              onChange={(e) => setSimulationMode(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <span style={{ fontWeight: 500 }}>Test simulation</span>
          </label>
        </div>
      </div>

      {/* Command Feedback Toast */}
      {commandFeedback && (
        <div className={`toast-banner toast-${
          commandFeedback.status === 'executed' ? 'success' :
          commandFeedback.status === 'rejected' ? 'warning' : 'danger'
        }`}>
          <div>
            <strong>Command result ({commandFeedback.status}):</strong> {commandFeedback.reason || 'Completed'}
          </div>
          <span style={{ fontSize: '0.78rem' }}>{commandFeedback.time}</span>
        </div>
      )}

      {/* Main Telemetry & Visualizer Layout */}
      <div className="telemetry-layout">
        {/* Left Column: Animated Top-Down Hardware SVG Visualizer */}
        <div>
          <TrolleyVisualizer
            telemetry={activeTelemetry}
            status={activeStatus}
            connection={activeConnection}
            lastSeen={activeLastSeen}
            isSimulated={simulationMode}
          />

          {/* Remote Control Controls */}
          <div className="card" style={{ marginTop: '16px' }}>
            <h3 className="card-title" style={{ marginBottom: '6px' }}>Remote Controls</h3>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Publish commands over MQTT with QoS 1 duplicate protection
            </p>

            <div className="trolley-controls">
              <button
                className="btn btn-primary"
                disabled={commandInProgress}
                onClick={() => handleSendCommand('START')}
              >
                <Play size={15} /> Start / Resume
              </button>

              <button
                className="btn"
                disabled={commandInProgress}
                onClick={() => handleSendCommand('PAUSE')}
              >
                <Pause size={15} /> Pause
              </button>

              <button
                className="btn btn-danger"
                disabled={commandInProgress}
                onClick={() => handleSendCommand('STOP')}
                style={{ fontWeight: 700 }}
              >
                <Square size={14} /> STOP
              </button>

              <button
                className="btn"
                disabled={commandInProgress}
                onClick={() => handleSendCommand('REQUEST_STATUS')}
                title="Refresh hardware status"
              >
                <RotateCw size={14} /> Refresh
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Sensor Readouts & Live Event Log */}
        <div>
          {/* Readout Grid */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: '12px' }}>Sensor Readouts</h3>
            
            <div className="readout-grid">
              <div className="readout-item">
                <div className="readout-label">Operating Mode</div>
                <div className="readout-value" style={{ color: 'var(--primary-dark)' }}>
                  {activeTelemetry?.mode || activeStatus?.state || 'OFFLINE'}
                </div>
              </div>

              <div className="readout-item">
                <div className="readout-label">Distance</div>
                <div className="readout-value">
                  {activeTelemetry?.ultrasonic?.distance_cm !== undefined
                    ? `${activeTelemetry.ultrasonic.distance_cm} cm`
                    : '--'}
                </div>
              </div>

              <div className="readout-item">
                <div className="readout-label">Servo Angle</div>
                <div className="readout-value">
                  {activeTelemetry?.ultrasonic?.servo_angle_deg !== undefined
                    ? `${activeTelemetry.ultrasonic.servo_angle_deg}°`
                    : '--'}
                </div>
              </div>

              <div className="readout-item">
                <div className="readout-label">Line IR (L/C/R)</div>
                <div className="readout-value" style={{ fontFamily: 'monospace' }}>
                  {activeTelemetry?.ir
                    ? `${activeTelemetry.ir.left ? '1' : '0'}.${activeTelemetry.ir.center ? '1' : '0'}.${activeTelemetry.ir.right ? '1' : '0'}`
                    : '--'}
                </div>
              </div>

              <div className="readout-item">
                <div className="readout-label">Wi-Fi Signal</div>
                <div className="readout-value">
                  {activeTelemetry?.rssi || activeStatus?.rssi
                    ? `${activeTelemetry?.rssi || activeStatus?.rssi} dBm`
                    : '--'}
                </div>
              </div>

              <div className="readout-item">
                <div className="readout-label">Uptime</div>
                <div className="readout-value">
                  {formatUptime(activeTelemetry?.uptime_s)}
                </div>
              </div>

              <div className="readout-item">
                <div className="readout-label">Firmware</div>
                <div className="readout-value" style={{ fontSize: '0.82rem' }}>
                  {activeStatus?.fw || 'v3.0.0-esp32'}
                </div>
              </div>

              <div className="readout-item">
                <div className="readout-label">Fault Status</div>
                <div className="readout-value" style={{ color: activeTelemetry?.fault ? 'var(--danger)' : 'var(--success)' }}>
                  {activeTelemetry?.fault || 'None'}
                </div>
              </div>
            </div>
          </div>

          {/* Event Log */}
          <div className="card">
            <h3 className="card-title" style={{ marginBottom: '10px' }}>Recent Device Events</h3>
            
            {events.length === 0 ? (
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>
                No events reported yet
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                {events.map((ev, i) => (
                  <div
                    key={ev.id || i}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--border)',
                      fontSize: '0.82rem'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                      <span style={{
                        fontWeight: 600,
                        color: ev.severity === 'warning' ? 'var(--accent-dark)' : 'var(--text)'
                      }}>
                        {ev.event}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                        {ev.device_ts || ev.received_at
                          ? new Date(ev.device_ts || ev.received_at).toLocaleTimeString()
                          : ''}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-muted)' }}>{ev.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
