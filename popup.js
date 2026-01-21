// Format time until reset
function formatTimeUntil(isoString) {
  if (!isoString) return '--';

  const resetTime = new Date(isoString);
  const now = new Date();
  const diffMs = resetTime - now;

  if (diffMs <= 0) return 'Resetting...';

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `Resets in ${days} day${days > 1 ? 's' : ''}`;
  }

  if (hours > 0) {
    return `Resets in ${hours} hr ${minutes} min`;
  }

  return `Resets in ${minutes} min`;
}

// Format weekly reset time
function formatWeeklyReset(isoString) {
  if (!isoString) return 'Resets --';

  const resetTime = new Date(isoString);
  const options = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  return `Resets ${resetTime.toLocaleString('en-US', options)}`;
}

// Format last updated time
function formatLastUpdated(timestamp) {
  if (!timestamp) return 'Never';

  const now = Date.now();
  const diffMs = now - timestamp;
  const minutes = Math.floor(diffMs / (1000 * 60));

  if (minutes < 1) return 'less than a minute ago';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;

  return 'over a day ago';
}

// Get color based on utilization percentage
function getColor(utilization) {
  if (utilization >= 80) return 'var(--accent-danger)';
  if (utilization >= 50) return 'var(--accent-warning)';
  return 'var(--accent-secondary)';
}

// Render usage data to the DOM
function renderUsage(usage) {
  const errorContainer = document.getElementById('error-container');
  const usageContent = document.getElementById('usage-content');

  if (!usage) {
    errorContainer.classList.remove('hidden');
    usageContent.classList.add('hidden');
    document.getElementById('error-message').textContent = 'No usage data available';
    return;
  }

  errorContainer.classList.add('hidden');
  usageContent.classList.remove('hidden');

  // 5-hour / Session usage
  const fiveHour = usage.five_hour;
  if (fiveHour) {
    const percent = fiveHour.utilization ?? 0;
    document.getElementById('daily-reset').textContent = formatTimeUntil(fiveHour.resets_at);
    document.getElementById('daily-progress').style.width = `${Math.min(percent, 100)}%`;
    document.getElementById('daily-progress').style.backgroundColor = getColor(percent);
    document.getElementById('daily-percent').textContent = `${Math.round(percent)}% used`;
  }

  // 7-day / Weekly usage (all models)
  const sevenDay = usage.seven_day;
  if (sevenDay) {
    const percent = sevenDay.utilization ?? 0;
    document.getElementById('weekly-reset').textContent = formatWeeklyReset(sevenDay.resets_at);
    document.getElementById('weekly-progress').style.width = `${Math.min(percent, 100)}%`;
    document.getElementById('weekly-progress').style.backgroundColor = getColor(percent);
    document.getElementById('weekly-percent').textContent = `${Math.round(percent)}% used`;
  }

  // Sonnet usage
  const sonnetUsage = usage.seven_day_sonnet;
  if (sonnetUsage) {
    const percent = sonnetUsage.utilization ?? 0;
    if (percent === 0 && !sonnetUsage.resets_at) {
      document.getElementById('sonnet-status').textContent = "You haven't used Sonnet yet";
    } else {
      document.getElementById('sonnet-status').textContent = formatWeeklyReset(sonnetUsage.resets_at);
    }
    document.getElementById('sonnet-progress').style.width = `${Math.min(percent, 100)}%`;
    document.getElementById('sonnet-progress').style.backgroundColor = getColor(percent);
    document.getElementById('sonnet-percent').textContent = `${Math.round(percent)}% used`;
  }
}

// Show error message
function showError(message) {
  const errorContainer = document.getElementById('error-container');
  const usageContent = document.getElementById('usage-content');

  errorContainer.classList.remove('hidden');
  usageContent.classList.add('hidden');

  let displayMessage = message || 'Unknown error occurred';
  if (message && (message.includes('401') || message.includes('403'))) {
    displayMessage = 'Please log in to claude.ai to view your usage';
  }

  console.error('Usage error:', message);
  document.getElementById('error-message').textContent = displayMessage;
}

// Load settings from storage
async function loadSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const defaults = {
    periodicEnabled: false,
    periodicInterval: 60,
    thresholdEnabled: false,
    thresholdCheckInterval: 5,
    sessionThreshold: 80,
    weeklyThreshold: 80
  };
  // Merge with defaults to handle old/missing settings
  const s = { ...defaults, ...settings };

  document.getElementById('periodic-enabled').checked = s.periodicEnabled;
  document.getElementById('periodic-interval').value = s.periodicInterval.toString();
  document.getElementById('threshold-enabled').checked = s.thresholdEnabled;
  document.getElementById('session-threshold').value = s.sessionThreshold;
  document.getElementById('weekly-threshold').value = s.weeklyThreshold;
}

// Save settings to storage
async function saveSettings() {
  const settings = {
    periodicEnabled: document.getElementById('periodic-enabled').checked,
    periodicInterval: parseInt(document.getElementById('periodic-interval').value, 10),
    thresholdEnabled: document.getElementById('threshold-enabled').checked,
    thresholdCheckInterval: 5, // Fixed at 5 minutes for threshold checks
    sessionThreshold: parseInt(document.getElementById('session-threshold').value, 10) || 80,
    weeklyThreshold: parseInt(document.getElementById('weekly-threshold').value, 10) || 80
  };

  await chrome.storage.sync.set({ settings });

  // Notify background script
  chrome.runtime.sendMessage({ type: 'settingsUpdated', settings });
}

// Refresh usage data
async function refreshUsage() {
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');

  try {
    const result = await chrome.runtime.sendMessage({ type: 'refresh' });

    if (result.success) {
      renderUsage(result.usage);
      document.getElementById('last-updated').textContent = 'Last updated: just now';
    } else {
      showError(result.error);
    }
  } catch (error) {
    showError(error.message);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
  }
}

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Load cached data first
  const cached = await chrome.storage.local.get(['usage', 'lastFetch', 'error']);

  if (cached.error && !cached.usage) {
    showError(cached.error);
  } else if (cached.usage) {
    renderUsage(cached.usage);
  }

  if (cached.lastFetch) {
    document.getElementById('last-updated').textContent =
      `Last updated: ${formatLastUpdated(cached.lastFetch)}`;
  }

  // Load settings
  await loadSettings();

  // Fetch fresh data
  refreshUsage();
});

// Settings toggle
document.getElementById('settings-toggle').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('hidden');
});

// Refresh button
document.getElementById('refresh-btn').addEventListener('click', refreshUsage);

// Settings change listeners
document.getElementById('periodic-enabled').addEventListener('change', saveSettings);
document.getElementById('periodic-interval').addEventListener('change', saveSettings);
document.getElementById('threshold-enabled').addEventListener('change', saveSettings);
document.getElementById('session-threshold').addEventListener('change', saveSettings);
document.getElementById('weekly-threshold').addEventListener('change', saveSettings);

// Test notification button
document.getElementById('test-notification').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'testNotification' });
});
