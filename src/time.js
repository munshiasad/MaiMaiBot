function getTimeParts(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(new Date());
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function getLocalDate(timeZone) {
  const { year, month, day } = getTimeParts(timeZone);
  return `${year}-${month}-${day}`;
}

function getLocalHour(timeZone) {
  const { hour } = getTimeParts(timeZone);
  return hour;
}

function getLocalDateTime(timeZone) {
  const { year, month, day, hour, minute, second } = getTimeParts(timeZone);
  const pad = (value) => String(value).padStart(2, "0");
  return `${year}-${month}-${day} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

module.exports = {
  getLocalDate,
  getLocalHour,
  getLocalDateTime
};
