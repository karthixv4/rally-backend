function spreadsheetBoolean(value) {
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', 'y', '1', 'opted in'].includes(String(value || '').trim().toLowerCase());
}

function normalizedHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function valueFor(row, aliases) {
  const matchingKey = Object.keys(row).find((key) => aliases.includes(normalizedHeader(key)));
  return matchingKey ? row[matchingKey] : undefined;
}

function normalizePhone(value) {
  const rawPhone = String(value || '').trim();
  return rawPhone && /^\d{10,15}$/.test(rawPhone) ? `+${rawPhone}` : rawPhone || null;
}

function normalizeStatus(row) {
  const waitlist = spreadsheetBoolean(valueFor(row, ['waitlist', 'onwaitlist']));
  const status = String(valueFor(row, ['status']) || '').trim().toUpperCase();
  return waitlist || status === 'WAITLISTED' ? 'WAITLISTED' : 'INVITED';
}

function normalizeRank(value) {
  const rank = Number(value);
  return Number.isInteger(rank) && rank > 0 ? rank : null;
}

function attendeeFromRow(row) {
  return {
    name: String(valueFor(row, ['name', 'fullname', 'attendeename']) || '').trim(),
    phone: normalizePhone(valueFor(row, ['phone', 'phonenumber', 'mobile', 'mobilenumber'])),
    optedIn: spreadsheetBoolean(valueFor(row, ['optedin', 'callconsent', 'consent', 'callpermission'])),
    status: normalizeStatus(row),
    waitlistRank: normalizeRank(valueFor(row, ['waitlistrank', 'rank']))
  };
}

function rowsToAttendees(headers, rows) {
  const headerRow = headers.map((header) => String(header || '').trim());
  const hasName = headerRow.some((header) => ['name', 'fullname', 'attendeename'].includes(normalizedHeader(header)));
  const hasPhone = headerRow.some((header) => ['phone', 'phonenumber', 'mobile', 'mobilenumber'].includes(normalizedHeader(header)));
  if (!hasName || !hasPhone) throw new Error('Use columns named Name and Phone. Optional columns are Call consent (Yes/No), Waitlist (Yes/No), and Waitlist rank.');

  const attendees = rows
    .map((row) => Object.fromEntries(headerRow.map((header, index) => [header, row[index] ?? ''])))
    .filter((row) => Object.values(row).some((value) => String(value ?? '').trim() !== ''))
    .map(attendeeFromRow);
  const invalidRows = attendees.map((attendee, index) => ({ attendee, row: index + 2 })).filter(({ attendee }) => !attendee.name);
  if (invalidRows.length) {
    const error = new Error('Every attendee row needs a name.');
    error.invalidRows = invalidRows.map(({ row }) => row);
    throw error;
  }
  return attendees;
}

// RFC 4180-style CSV parser for the public Google Forms response-sheet export.
function parseCsvRows(csv) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') { value += '"'; index += 1; } else if (character === '"') quoted = false; else value += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ',') { row.push(value); value = ''; }
    else if (character === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += character;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

function attendeesFromCsv(csv) {
  const rows = parseCsvRows(String(csv || '').replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('The Google Forms response sheet has no attendee rows yet.');
  return rowsToAttendees(rows[0], rows.slice(1));
}

function importSummary(attendees) {
  const callable = attendees.filter((attendee) => attendee.optedIn && attendee.phone && attendee.status === 'INVITED');
  return {
    total: attendees.length,
    callable: callable.length,
    waitlisted: attendees.filter((attendee) => attendee.status === 'WAITLISTED').length,
    notOptedIn: attendees.filter((attendee) => !attendee.optedIn).length,
    missingPhone: attendees.filter((attendee) => !attendee.phone).length
  };
}

module.exports = { attendeesFromCsv, importSummary, rowsToAttendees };
