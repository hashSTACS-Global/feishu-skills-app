/**
 * tools/lib/calendar.mjs — Feishu Calendar (12 actions, thin API adapter).
 *
 * Contract:
 *   - No 'primary' default for calendar_id. Caller must supply it explicitly
 *     (or first call get_primary / list_calendars to obtain it).
 *   - No auto-reminders, no auto-fetch meeting_url, no auto-create meeting chat.
 *     Those are separate explicit actions if caller needs them.
 *   - Non-all-day events require a timezone (ISO tz or args.time_zone field).
 *   - Arrays in → arrays out. No comma-string coercion.
 */

import {
  FeishuError,
  apiCall,
  checkApi,
  requireParam,
  requireOneOf,
} from './_common.mjs';
import { getTenantAccessToken } from '../auth.mjs';

const DOMAIN = { domain: 'calendar' };

const REPEAT_RRULE = {
  daily: 'FREQ=DAILY',
  weekly: 'FREQ=WEEKLY',
  monthly: 'FREQ=MONTHLY',
  workdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
};

// ---------------------------------------------------------------------------
// Helpers (pure data transforms — not smart-fixers)
// ---------------------------------------------------------------------------

function toUnixSecondsFromEpochMs(ms) {
  return String(Math.floor(ms / 1000));
}

function toUnixSeconds(v, label) {
  const ms = new Date(v).getTime();
  if (Number.isNaN(ms)) {
    throw new FeishuError('invalid_param', `${label} 无法解析为时间: ${v}`, { param: label, got: v });
  }
  return toUnixSecondsFromEpochMs(ms);
}

function buildEventTime({ value, timeZone, isAllDay, label }) {
  if (isAllDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      throw new FeishuError(
        'invalid_param',
        `${label} 全天事件要求 YYYY-MM-DD 形式，got: ${value}`,
        { param: label, got: value },
      );
    }
    return { date: value };
  }
  if (!timeZone) {
    throw new FeishuError(
      'missing_param',
      'time_zone 必填（非全天事件需要时区，如 Asia/Shanghai）',
      { param: 'time_zone' },
    );
  }
  return { timestamp: toUnixSeconds(value, label), timezone: timeZone };
}

function toRFC3339(input, label) {
  const trimmed = String(input).trim();
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new FeishuError('invalid_param', `${label} 无效时间: ${input}`, { param: label });
    }
    return trimmed;
  }
  throw new FeishuError(
    'invalid_param',
    `${label} 必须带时区（ISO 8601，如 2026-04-20T10:00:00+08:00 或 2026-04-20T02:00:00Z）。不要传无时区时间`,
    { param: label, got: input },
  );
}

function formatEventTime(timeObj) {
  if (!timeObj) return '';
  if (timeObj.date) return timeObj.date;
  const ts = parseInt(timeObj.timestamp, 10);
  if (!ts || Number.isNaN(ts)) return '';
  const tz = timeObj.timezone || 'Asia/Shanghai';
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function enrichEventTimes(event) {
  if (!event) return event;
  const enriched = { ...event };
  if (event.start_time) enriched.start_time_str = formatEventTime(event.start_time);
  if (event.end_time)   enriched.end_time_str   = formatEventTime(event.end_time);
  return enriched;
}

function requireArrayOfStrings(args, key, hint) {
  const v = args[key];
  if (!Array.isArray(v)) {
    throw new FeishuError('invalid_param', hint ? `${key} 必须是字符串数组（${hint}）` : `${key} 必须是字符串数组`, { param: key, got: typeof v });
  }
  if (v.length === 0) {
    throw new FeishuError('missing_param', `${key} 不能为空数组`, { param: key });
  }
  v.forEach((s, i) => {
    if (typeof s !== 'string' || !s.trim()) {
      throw new FeishuError('invalid_param', `${key}[${i}] 必须是非空字符串`, { param: `${key}[${i}]` });
    }
  });
  return v;
}

function requireCalendarId(args) {
  requireParam(
    args,
    'calendar_id',
    '用户主日历 id 可先调 get_primary 获取；日历列表调 list_calendars',
  );
}

function requirePageSize(args, max = 500) {
  if (args.page_size === undefined || args.page_size === null) return null;
  if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > max) {
    throw new FeishuError(
      'invalid_param',
      `page_size 必须是 1-${max} 的整数`,
      { param: 'page_size', max },
    );
  }
  return args.page_size;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function listCalendars(args, token) {
  const pageSize = requirePageSize(args, 1000);
  const query = {};
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', '/calendar/v4/calendars', token, { query });
  checkApi(data, 'List calendars', DOMAIN);
  return {
    action: 'list_calendars',
    calendars: data.data?.calendar_list || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

export async function getPrimary(args, token) {
  const data = await apiCall('POST', '/calendar/v4/calendars/primary', token, { body: {} });
  checkApi(data, 'Get primary calendar', DOMAIN);
  return {
    action: 'get_primary',
    calendar: data.data?.calendars?.[0]?.calendar || data.data,
  };
}

/**
 * Create an event.
 *
 * Args (relevant):
 *   calendar_id        required
 *   summary            required
 *   start_time         required (ISO string or ms; see is_all_day)
 *   end_time           required
 *   is_all_day         boolean (default false). If true, start/end must be YYYY-MM-DD
 *   time_zone          required when is_all_day=false (e.g. "Asia/Shanghai")
 *   description        optional
 *   location           optional string
 *   attendee_ids       optional array of open_id strings
 *   recurrence         optional RRULE string (takes precedence)
 *   repeat             optional shortcut: daily/weekly/monthly/workdays
 *   reminders          optional array [{ minutes: N }]
 *   auto_record        optional boolean
 *   attendee_ability   optional ('none'|'can_see_others'|'can_invite_others'|'can_modify_event')
 *   need_attendee      optional boolean (return attendees in response)
 */
export async function createEvent(args, token) {
  requireCalendarId(args);
  requireParam(args, 'summary', '日程标题');
  requireParam(args, 'start_time', '开始时间（全天用 YYYY-MM-DD，否则 ISO）');
  requireParam(args, 'end_time', '结束时间');

  const isAllDay = !!args.is_all_day;

  const body = {
    summary: args.summary,
    start_time: buildEventTime({ value: args.start_time, timeZone: args.time_zone, isAllDay, label: 'start_time' }),
    end_time: buildEventTime({ value: args.end_time, timeZone: args.time_zone, isAllDay, label: 'end_time' }),
  };
  if (args.description !== undefined) body.description = String(args.description);
  if (args.location) body.location = { name: String(args.location) };

  if (args.auto_record !== undefined) {
    body.vchat = { vc_type: 'vc', meeting_settings: { auto_record: !!args.auto_record } };
  } else if (args.with_vchat) {
    body.vchat = { vc_type: 'vc' };
  }

  if (args.reminders !== undefined) {
    if (!Array.isArray(args.reminders)) {
      throw new FeishuError('invalid_param', 'reminders 必须是数组，如 [{"minutes": 15}]', { param: 'reminders' });
    }
    body.reminders = args.reminders;
  }

  let rrule = null;
  if (args.recurrence) {
    rrule = String(args.recurrence);
  } else if (args.repeat) {
    if (!REPEAT_RRULE[args.repeat]) {
      throw new FeishuError(
        'invalid_param',
        `repeat 必须是 ${Object.keys(REPEAT_RRULE).join(' / ')} 之一，或直接用 recurrence 传标准 RRULE`,
        { param: 'repeat', got: args.repeat },
      );
    }
    rrule = REPEAT_RRULE[args.repeat];
  }
  if (rrule) body.recurrence = rrule;

  if (args.attendee_ability) body.attendee_ability = args.attendee_ability;

  const attendeeIds = args.attendee_ids !== undefined
    ? requireArrayOfStrings(args, 'attendee_ids', 'open_id 数组')
    : [];

  const query = { user_id_type: 'open_id' };
  if (args.need_attendee) query.need_attendee = 'true';

  const data = await apiCall(
    'POST',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events`,
    token,
    { body, query },
  );
  checkApi(data, 'Create event', DOMAIN);

  const event = data.data?.event;
  const eventId = event?.event_id;

  // Add attendees via dedicated endpoint (more reliable than inline attendees on create)
  if (attendeeIds.length > 0 && eventId) {
    const attBody = {
      attendees: attendeeIds.map((id) => ({ type: 'user', user_id: id, is_optional: false })),
    };
    const attData = await apiCall(
      'POST',
      `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(eventId)}/attendees`,
      token,
      { body: attBody, query: { user_id_type: 'open_id' } },
    );
    checkApi(attData, 'Add attendees (create_event)', DOMAIN);
  }

  return {
    action: 'create_event',
    event,
    reply: `日程「${args.summary}」已创建${rrule ? `（重复：${args.repeat || args.recurrence}）` : ''}`,
  };
}

export async function listEvents(args, token) {
  requireCalendarId(args);
  const pageSize = requirePageSize(args, 500);
  const query = {};
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  if (args.start_min) query.start_time = toUnixSeconds(args.start_min, 'start_min');
  if (args.start_max) query.end_time = toUnixSeconds(args.start_max, 'start_max');
  if (args.sync_token) query.sync_token = args.sync_token;
  if (args.anchor_time) query.anchor_time = args.anchor_time;

  const data = await apiCall(
    'GET',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events`,
    token,
    { query },
  );
  checkApi(data, 'List events', DOMAIN);
  const events = (data.data?.items || []).map(enrichEventTimes);
  return {
    action: 'list_events',
    events,
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
    sync_token: data.data?.sync_token,
    reply: events.length === 0 ? '当前时间段内没有日程。' : `共 ${events.length} 条日程。`,
  };
}

export async function getEvent(args, token) {
  requireCalendarId(args);
  requireParam(args, 'event_id');
  const query = { user_id_type: 'open_id' };
  if (args.need_attendee) query.need_attendee = 'true';
  const data = await apiCall(
    'GET',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}`,
    token,
    { query },
  );
  checkApi(data, 'Get event', DOMAIN);
  return { action: 'get_event', event: enrichEventTimes(data.data?.event) };
}

export async function updateEvent(args, token) {
  requireCalendarId(args);
  requireParam(args, 'event_id');

  const body = {};
  if (args.summary !== undefined) body.summary = String(args.summary);
  if (args.description !== undefined) body.description = String(args.description);
  if (args.location !== undefined) body.location = { name: String(args.location) };
  const isAllDay = !!args.is_all_day;

  if (args.start_time !== undefined) {
    body.start_time = buildEventTime({ value: args.start_time, timeZone: args.time_zone, isAllDay, label: 'start_time' });
  }
  if (args.end_time !== undefined) {
    body.end_time = buildEventTime({ value: args.end_time, timeZone: args.time_zone, isAllDay, label: 'end_time' });
  }
  if (Object.keys(body).length === 0) {
    throw new FeishuError('missing_param', '至少传一个要更新的字段：summary / description / location / start_time / end_time');
  }

  const data = await apiCall(
    'PATCH',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Update event', DOMAIN);
  return { action: 'update_event', event: data.data?.event, reply: '日程已更新' };
}

export async function deleteEvent(args, token) {
  requireCalendarId(args);
  requireParam(args, 'event_id');
  const data = await apiCall(
    'DELETE',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}`,
    token,
  );
  checkApi(data, 'Delete event', DOMAIN);
  return { action: 'delete_event', success: true, reply: '日程已删除' };
}

export async function searchEvents(args, token) {
  requireCalendarId(args);
  requireParam(args, 'query', '搜索关键字');
  const pageSize = requirePageSize(args, 50);
  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;

  const data = await apiCall(
    'POST',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/search`,
    token,
    { body: { query: args.query }, query },
  );
  checkApi(data, 'Search events', DOMAIN);
  const events = (data.data?.items || []).map(enrichEventTimes);
  return {
    action: 'search_events',
    events,
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

export async function addAttendees(args, token) {
  requireCalendarId(args);
  requireParam(args, 'event_id');
  const userIds = requireArrayOfStrings(args, 'attendee_ids', 'open_id 数组（要添加的参与者 open_ids）');
  const optional = args.is_optional === true;

  const body = {
    attendees: userIds.map((id) => ({ type: 'user', user_id: id, is_optional: optional })),
  };
  const data = await apiCall(
    'POST',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}/attendees`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Add attendees', DOMAIN);
  return { action: 'add_attendees', attendees: data.data?.attendees, reply: '参与者已添加' };
}

export async function listAttendees(args, token) {
  requireCalendarId(args);
  requireParam(args, 'event_id');
  const pageSize = requirePageSize(args, 500);
  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall(
    'GET',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}/attendees`,
    token,
    { query },
  );
  checkApi(data, 'List attendees', DOMAIN);
  return {
    action: 'list_attendees',
    attendees: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

export async function removeAttendees(args, token) {
  requireCalendarId(args);
  requireParam(args, 'event_id');
  const ids = requireArrayOfStrings(args, 'attendee_ids', 'attendee_id 字符串数组');
  const data = await apiCall(
    'POST',
    `/calendar/v4/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}/attendees/batch_delete`,
    token,
    { body: { attendee_ids: ids } },
  );
  checkApi(data, 'Remove attendees', DOMAIN);
  return { action: 'remove_attendees', success: true, reply: '参与者已移除' };
}

/**
 * Check free/busy for a set of users.
 *
 * Either pass `user_ids` directly, OR pass `names` + `chat_id` to resolve names
 * against chat members (tenant token required).
 * Multiple-match on name is an error (caller must disambiguate).
 */
export async function checkFreebusy(args, token, cfg) {
  requireParam(args, 'start_time', 'ISO 8601 with tz，如 2026-04-20T10:00:00+08:00');
  requireParam(args, 'end_time');
  requireOneOf(args, ['user_ids', 'names'], '要么直接传 open_id 数组（user_ids），要么传 names + chat_id 由 pipeline 解析');

  const timeMin = toRFC3339(args.start_time, 'start_time');
  const timeMax = toRFC3339(args.end_time, 'end_time');

  const userIds = [];
  const idToName = {};
  const warnings = [];

  if (args.user_ids !== undefined) {
    requireArrayOfStrings(args, 'user_ids', 'open_id 数组').forEach((id) => userIds.push(id));
  }

  if (args.names !== undefined) {
    const names = requireArrayOfStrings(args, 'names', '姓名数组');
    requireParam(args, 'chat_id', '按姓名查忙闲时需要 chat_id 做作用域');
    if (!cfg?.appId || !cfg?.appSecret) {
      throw new FeishuError('missing_param', 'names 解析需要 cfg.appId + cfg.appSecret', { param: 'cfg' });
    }
    const tenantToken = await getTenantAccessToken(cfg.appId, cfg.appSecret);
    const resolved = await searchChatMembersByNameStrict(args.chat_id, names, tenantToken);
    for (const r of resolved) {
      if (r.open_id) {
        userIds.push(r.open_id);
        idToName[r.open_id] = r.display_name || r.name;
      } else {
        warnings.push(r.error);
      }
    }
    if (userIds.length === 0) {
      throw new FeishuError('user_not_found', `未在群中解析到任何用户：${warnings.join('; ')}`, { warnings });
    }
  }

  const results = await Promise.all(userIds.map(async (uid) => {
    const body = { time_min: timeMin, time_max: timeMax, user_id: uid };
    const data = await apiCall('POST', '/calendar/v4/freebusy/list', token, {
      body,
      query: { user_id_type: 'open_id' },
    });
    checkApi(data, `Freebusy user=${uid}`, DOMAIN);
    const busyPeriods = data.data?.freebusy_list || [];
    return {
      user_id: uid,
      ...(idToName[uid] && { display_name: idToName[uid] }),
      busy_periods: busyPeriods,
      is_free: busyPeriods.length === 0,
    };
  }));

  return {
    action: 'check_freebusy',
    freebusy: results,
    ...(warnings.length > 0 && { warnings }),
  };
}

/**
 * Strict name resolution: one exact-substring match per name.
 * If 0 matches → record error. If >1 matches → error with candidate list.
 */
async function searchChatMembersByNameStrict(chatId, names, appToken) {
  const allMembers = [];
  let pageToken = null;
  do {
    const query = { member_id_type: 'open_id' };
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall('GET', `/im/v1/chats/${encodeURIComponent(chatId)}/members`, appToken, { query });
    checkApi(data, 'List chat members', DOMAIN);
    for (const m of data.data?.items ?? []) allMembers.push(m);
    pageToken = data.data?.has_more ? data.data.page_token : null;
  } while (pageToken);

  return names.map((name) => {
    const q = name.toLowerCase();
    const matched = allMembers.filter((m) => (m.name || '').toLowerCase().includes(q));
    if (matched.length === 0) {
      return { name, open_id: null, error: `未在群中找到"${name}"` };
    }
    if (matched.length > 1) {
      const candidates = matched.slice(0, 10).map((m) => `${m.name}(${m.member_id})`).join(', ');
      return { name, open_id: null, error: `群中有多个匹配"${name}"，请用 user_ids 指定（候选: ${candidates}${matched.length > 10 ? '...' : ''}）` };
    }
    return { name, open_id: matched[0].member_id, display_name: matched[0].name };
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const ACTIONS = {
  list_calendars: listCalendars,
  get_primary: getPrimary,
  create_event: createEvent,
  list_events: listEvents,
  get_event: getEvent,
  update_event: updateEvent,
  delete_event: deleteEvent,
  search_events: searchEvents,
  add_attendees: addAttendees,
  list_attendees: listAttendees,
  remove_attendees: removeAttendees,
  check_freebusy: checkFreebusy,
};

export { FeishuError };
