// Default settings
const DEFAULT_SETTINGS = {
  // Badge display
  badgeDisplay: 'session', // 'session' or 'weekly'

  // Periodic notifications - notify every N minutes with current usage
  periodicEnabled: false,
  periodicInterval: 60, // minutes

  // Threshold alerts - notify when usage crosses threshold
  thresholdEnabled: false,
  thresholdCheckInterval: 5, // minutes (frequent checks)
  sessionThreshold: 80,
  weeklyThreshold: 80
};

// Get organization ID with 'chat' capability
async function getOrgId() {
  const cached = await chrome.storage.local.get('orgId');
  if (cached.orgId) {
    return cached.orgId;
  }

  const response = await fetch('https://claude.ai/api/organizations', {
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch organizations: ${response.status}`);
  }

  const orgs = await response.json();
  const chatOrg = orgs.find(org =>
    org.capabilities && org.capabilities.includes('chat')
  );

  if (!chatOrg) {
    throw new Error('No organization with chat capability found');
  }

  await chrome.storage.local.set({ orgId: chatOrg.uuid });
  return chatOrg.uuid;
}

// Fetch usage data for an organization
async function getUsage(orgId) {
  const response = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
    credentials: 'include'
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch usage: ${response.status}`);
  }

  return response.json();
}

// Get color based on utilization percentage
function getColor(utilization) {
  if (utilization >= 80) return '#ef4444'; // Red
  if (utilization >= 50) return '#eab308'; // Yellow
  return '#0891b2'; // Teal
}

// Update badge with 5-hour usage
function updateBadge(utilization) {
  if (utilization === null || utilization === undefined) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }

  const rounded = Math.round(utilization);
  chrome.action.setBadgeText({ text: rounded.toString() });
  chrome.action.setBadgeBackgroundColor({ color: getColor(utilization) });
}

// Format session time remaining (hours/minutes)
function formatSessionReset(isoString) {
  if (!isoString) return '';

  const resetTime = new Date(isoString);
  const now = new Date();
  const diffMs = resetTime - now;

  if (diffMs <= 0) return 'resetting soon';

  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Format weekly reset as day/time (e.g., "Fri 11:30 PM")
function formatWeeklyReset(isoString) {
  if (!isoString) return '';

  const resetTime = new Date(isoString);
  const options = { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  return resetTime.toLocaleString('en-US', options);
}

// Build usage notification message
function buildUsageMessage(usage) {
  const sessionUtil = usage.five_hour?.utilization ?? 0;
  const weeklyUtil = usage.seven_day?.utilization ?? 0;
  const sessionReset = formatSessionReset(usage.five_hour?.resets_at);
  const weeklyReset = formatWeeklyReset(usage.seven_day?.resets_at);

  let message = `Session: ${Math.round(sessionUtil)}%`;
  if (sessionReset) message += ` (resets in ${sessionReset})`;
  message += `\nWeekly: ${Math.round(weeklyUtil)}%`;
  if (weeklyReset) message += ` (resets ${weeklyReset})`;

  return message;
}

// Send usage notification
function sendUsageNotification(usage, isAlert = false) {
  chrome.notifications.create('usage-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: isAlert ? 'Claude Usage Alert' : 'Claude Usage Update',
    message: buildUsageMessage(usage),
    priority: isAlert ? 2 : 1
  });
}

// Check thresholds and send alert notification if crossed
async function checkThresholdAlerts(usage, settings) {
  const { lastNotified } = await chrome.storage.local.get('lastNotified') || { lastNotified: {} };
  const newLastNotified = { ...lastNotified };

  const sessionUtil = usage.five_hour?.utilization ?? 0;
  const weeklyUtil = usage.seven_day?.utilization ?? 0;

  const sessionWasAbove = lastNotified.session === true;
  const weeklyWasAbove = lastNotified.weekly === true;
  const sessionIsAbove = sessionUtil >= settings.sessionThreshold;
  const weeklyIsAbove = weeklyUtil >= settings.weeklyThreshold;

  // Send alert if either threshold just crossed
  const sessionJustCrossed = sessionIsAbove && !sessionWasAbove;
  const weeklyJustCrossed = weeklyIsAbove && !weeklyWasAbove;

  if (sessionJustCrossed || weeklyJustCrossed) {
    sendUsageNotification(usage, true);
  }

  // Update state
  newLastNotified.session = sessionIsAbove;
  newLastNotified.weekly = weeklyIsAbove;

  await chrome.storage.local.set({ lastNotified: newLastNotified });
}

// Main fetch function - fetches and caches usage data
async function fetchAndCache(options = {}) {
  const { triggerPeriodic = false, triggerThreshold = false } = options;

  try {
    console.log('Fetching usage data...', { triggerPeriodic, triggerThreshold });
    const orgId = await getOrgId();
    const usage = await getUsage(orgId);
    console.log('Got usage:', usage);

    await chrome.storage.local.set({
      usage,
      lastFetch: Date.now(),
      error: null
    });

    // Get settings
    const { settings } = await chrome.storage.sync.get('settings');
    const currentSettings = { ...DEFAULT_SETTINGS, ...settings };

    // Update badge based on setting
    const badgeUtil = currentSettings.badgeDisplay === 'weekly'
      ? usage.seven_day?.utilization
      : usage.five_hour?.utilization;
    updateBadge(badgeUtil);

    // Send periodic notification if triggered and enabled
    if (triggerPeriodic && currentSettings.periodicEnabled) {
      sendUsageNotification(usage, false);
    }

    // Check threshold alerts if triggered and enabled
    if (triggerThreshold && currentSettings.thresholdEnabled) {
      await checkThresholdAlerts(usage, currentSettings);
    }

    return { success: true, usage };
  } catch (error) {
    console.error('Error fetching usage:', error);
    const errorMsg = error.message || 'Unknown error';
    await chrome.storage.local.set({ error: errorMsg });
    return { success: false, error: errorMsg };
  }
}

// Setup alarms based on settings
async function setupAlarms(settings) {
  // Clear existing alarms
  await chrome.alarms.clear('periodicNotification');
  await chrome.alarms.clear('thresholdCheck');

  // Setup periodic notification alarm if enabled
  if (settings.periodicEnabled) {
    console.log('Setting up periodic alarm:', settings.periodicInterval, 'minutes');
    chrome.alarms.create('periodicNotification', {
      periodInMinutes: settings.periodicInterval
    });
  }

  // Setup threshold check alarm if enabled (frequent checks)
  if (settings.thresholdEnabled) {
    console.log('Setting up threshold alarm:', settings.thresholdCheckInterval, 'minutes');
    chrome.alarms.create('thresholdCheck', {
      periodInMinutes: settings.thresholdCheckInterval
    });
  }
}

// Initialize extension
chrome.runtime.onInstalled.addListener(async () => {
  // Initialize settings if not set
  const { settings } = await chrome.storage.sync.get('settings');
  if (!settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }

  // Initialize lastNotified
  await chrome.storage.local.set({ lastNotified: { session: false, weekly: false } });

  // Fetch initial data
  await fetchAndCache();

  // Setup alarms
  await setupAlarms(settings || DEFAULT_SETTINGS);
});

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('Alarm triggered:', alarm.name);

  if (alarm.name === 'periodicNotification') {
    await fetchAndCache({ triggerPeriodic: true });
  } else if (alarm.name === 'thresholdCheck') {
    await fetchAndCache({ triggerThreshold: true });
  }
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'refresh') {
    fetchAndCache().then(sendResponse);
    return true;
  }

  if (message.type === 'settingsUpdated') {
    const newSettings = message.settings;
    setupAlarms(newSettings);

    // Update badge with new display setting
    chrome.storage.local.get('usage').then(({ usage }) => {
      if (usage) {
        const badgeUtil = newSettings.badgeDisplay === 'weekly'
          ? usage.seven_day?.utilization
          : usage.five_hour?.utilization;
        updateBadge(badgeUtil);
      }
    });

    // If threshold alerts just enabled, do an immediate check
    if (newSettings.thresholdEnabled) {
      fetchAndCache({ triggerThreshold: true });
    }

    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'getUsage') {
    chrome.storage.local.get(['usage', 'lastFetch', 'error']).then(sendResponse);
    return true;
  }

  if (message.type === 'testNotification') {
    chrome.storage.local.get('usage').then(({ usage }) => {
      if (usage) {
        sendUsageNotification(usage, false);
      }
    });
    return true;
  }
});

// Also run on startup (for when browser restarts)
chrome.runtime.onStartup.addListener(async () => {
  await fetchAndCache();
  const { settings } = await chrome.storage.sync.get('settings');
  await setupAlarms(settings || DEFAULT_SETTINGS);
});
