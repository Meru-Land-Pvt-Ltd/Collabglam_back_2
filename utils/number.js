'use strict';

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeDivide(numerator, denominator) {
  const n = toNumber(numerator);
  const d = toNumber(denominator);
  if (!d) return 0;
  return n / d;
}

function percent(numerator, denominator, decimals = 2) {
  return Number((safeDivide(numerator, denominator) * 100).toFixed(decimals));
}

function clamp(value, min = 0, max = 100) {
  const n = toNumber(value);
  return Math.max(min, Math.min(max, n));
}

function round(value, decimals = 2) {
  const n = toNumber(value);
  return Number(n.toFixed(decimals));
}

function parseIsoDurationToSeconds(duration) {
  if (!duration || typeof duration !== 'string') return 0;
  const match = duration.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;

  const days = toNumber(match[1]);
  const hours = toNumber(match[2]);
  const minutes = toNumber(match[3]);
  const seconds = toNumber(match[4]);

  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function formatDurationFromSeconds(seconds) {
  const totalSeconds = Math.max(0, Math.round(toNumber(seconds)));
  if (!totalSeconds) return 'Not available';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (hours) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function getAgeLabel(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const diffMs = Date.now() - date.getTime();
  const days = Math.max(0, Math.floor(diffMs / 86400000));
  if (days < 30) return `${days} days`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} months`;

  const years = Math.floor(months / 12);
  const extraMonths = months % 12;
  return extraMonths ? `${years} years ${extraMonths} months` : `${years} years`;
}

function compactNumber(value) {
  const n = toNumber(value, 0);
  if (n >= 1000000000) return `${round(n / 1000000000, 1)}B`;
  if (n >= 1000000) return `${round(n / 1000000, 1)}M`;
  if (n >= 1000) return `${round(n / 1000, 1)}K`;
  return String(Math.round(n));
}

function money(value, decimals = 2) {
  const n = toNumber(value, 0);
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;
}

module.exports = {
  toNumber,
  safeDivide,
  percent,
  clamp,
  round,
  parseIsoDurationToSeconds,
  formatDurationFromSeconds,
  getAgeLabel,
  compactNumber,
  money
};
