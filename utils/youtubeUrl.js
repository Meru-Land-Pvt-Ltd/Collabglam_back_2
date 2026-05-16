'use strict';

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

function extractYouTubeVideoId(input) {
  if (!input || typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (VIDEO_ID_REGEX.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0];
      return VIDEO_ID_REGEX.test(id || '') ? id : null;
    }

    if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') {
        const id = url.searchParams.get('v');
        return VIDEO_ID_REGEX.test(id || '') ? id : null;
      }

      const parts = url.pathname.split('/').filter(Boolean);
      const supportedPrefixes = new Set(['shorts', 'embed', 'live', 'v']);
      if (parts.length >= 2 && supportedPrefixes.has(parts[0])) {
        const id = parts[1];
        return VIDEO_ID_REGEX.test(id || '') ? id : null;
      }
    }
  } catch (error) {
    return null;
  }

  return null;
}

function buildYouTubeWatchUrl(videoId) {
  return VIDEO_ID_REGEX.test(String(videoId || ''))
    ? `https://www.youtube.com/watch?v=${videoId}`
    : '';
}

module.exports = {
  extractYouTubeVideoId,
  buildYouTubeWatchUrl
};
