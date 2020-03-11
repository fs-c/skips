const BASE_URL = 'https://erato.webuntis.com/WebUntis';

const fetch = require('node-fetch');
const { startOfISOWeek } = require('date-fns');

const WebUntis = class WebUntis {
    /**
     * @private
     * @param {string} method 
     * @param {object} [params={}] 
     * 
     * @returns {object} - A RPC spec compliant body object with the given
     * method and parameters.
     */
    static rpcify(method, params = {}) {
        return {
            jsonrpc: '2.0',
            method, params,
            id: Date.now().toString(36),
        };
    }

    static async request(...args) {
        const result = await fetch(...args);

        console.log(args[0], { ok: result.ok, status: result.status });

        if (!result.ok) {
            console.error(`request failed (${result.statusText})`);

            const text = await result.text();
            throw new Error(text);
        } else {
            return await result.json();
        }
    }

    /**
     * @param {string} untisTime 
     * 
     * @returns {{hour: number, minute: number}}
     */
    static parseUntisTime(untisTime) {
        const timeString = untisTime.toString().padStart(4, ' ');

        return {
            hour: parseInt(timeString.slice(0, 2).trim()),
            minute: parseInt(timeString.slice(2, 4).trim()),
        };
    }

    /**
     * @param {string} untisDate - 'YYYYMMDD'
     * 
     * @returns {Date}
     */
    static parseUntisDate(untisDate) {
        const dateString = untisDate.toString();

        const year = parseInt(dateString.slice(0, 4));
        const month = parseInt(dateString.slice(4, 6));
        const day = parseInt(dateString.slice(6, 8));

        const date = new Date();

        date.setDate(day);
        date.setFullYear(year);
        date.setMonth(month - 1);

        // Zero these to prevent confusion
        date.setHours(0);
        date.setMinutes(0);
        date.setSeconds(0);
        date.setMilliseconds(0);

        return date;
    }

    /**
     * @param {String | Number} untisDate - 'YYYYMMDD'
     * @param {String | Number} untisTime - 'HHMM' local 24h based time
     * 
     * @returns {Date}
     */
    static parseUntisDateTime(untisDate, untisTime) {
        const date = WebUntis.parseUntisDate(untisDate);
        const time = WebUntis.parseUntisTime(untisTime);

        date.setHours(time.hour + 1);
        date.setMinutes(time.minute);

        return date;
    }

    /**
     * @param {Date} date 
     * @param {string} [separator=''] 
     * 
     * @returns {string} - An Untis date of the format 'YYYY*MM*DD' where '*'
     * stands for the optional separator.
     */
    static dateToUntisDate(date, separator = '') {
        const day = (date.getDate()).toString().padStart(2, '0');
        const month = (date.getMonth() + 1).toString().padStart(2, '0');

        return date.getFullYear() + separator + month + separator + day;
    }

    school = null;

    personId = null;
    sessionId = null;

    /**
     * Creates a WebUntis instance.
     * 
     * @param {string} school 
     */
    constructor(school) {
        if (!school) {
            throw new Error('Insufficient arguments: school name required');
        }

        this.school = school;
    }

    /**
     * @private
     */
    get rpcUri() { return `${BASE_URL}/jsonrpc.do?school=${this.school}`; }

    /**
     * Authenticates this instance with the given login data.
     * 
     * @param {string} username 
     * @param {string} password 
     * 
     * @returns {{sessionId: string, personId: number}}
     */
    async authenticate(username, password) {
        if (!username || !password) {
            throw new Error('Insufficient arguments: username, password required');
        }

        const { sessionId, personId } = (await WebUntis.request(this.rpcUri, {
            'method': 'POST',
            'body': JSON.stringify(WebUntis.rpcify('authenticate', {
                user: username, password,
            })),
        })).result;

        if (!sessionId || !personId) {
            throw new Error('Missing response data');
        }

        if (sessionId.length !== 32) {
            console.log('Unusual session ID length encountered',
                sessionId.length);
        }

        this.personId = personId;
        this.sessionId = sessionId;

        return { sessionId, personId };
    }

    /**
     * @typedef Absence
     * @type {object}
     * @property {Date} startDate
     * @property {Date} endDate
     * @property {boolean} excused
     */

    /**
     * Returns all absences, excused and unexcused, in the given interval for 
     * the current user.
     * 
     * @param {Date} startDate 
     * @param {Date} endDate 
     * 
     * @returns {Absence[]}
     */
    async getAbsences(startDate, endDate) {
        if (!this.sessionId) {
            throw new Error('Unauthenticated instance');
        }

        if (!startDate || !endDate) {
            throw new Error('Insufficient arguments: startDate, endDate required');
        }

        const uri = `${BASE_URL}/api/classreg/absences/students?`
            + `studentId=${this.personId}&excuseStatusId=-1&includeTodaysAbsence=true`
            + `&startDate=${WebUntis.dateToUntisDate(startDate)}`
            + `&endDate=${WebUntis.dateToUntisDate(endDate)}`;

        const { absences } = (await WebUntis.request(uri, {
            'headers': {
                'accept': 'application/json',
                'accept-language': 'en-US,en;q=0.9',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                // Removed `schoolname` and `traceid` cookies
                'cookie': `JSESSIONID=${this.sessionId}`,
            },
            'referrer': 'https://erato.webuntis.com/WebUntis/?school=borglinz',
            'referrerPolicy': 'no-referrer-when-downgrade',
            'body': null,
            'method': 'GET',
            'mode': 'cors',
        })).data;

        if (absences === null || typeof absences !== 'object' ||
            absences.length === undefined)
        {
            throw new Error('Missing response data');
        }

        return absences.map((e) => {
            const startDate = WebUntis.parseUntisDateTime(e.startDate,
                e.startTime);
            const endDate = WebUntis.parseUntisDateTime(e.endDate,
                e.endTime);

            return {
                startDate, endDate,
                excused: e.isExcused,
            };
        });
    }

    /**
     * Gets the current schoolyear.
     * 
     * @returns {{ name: string, startDate: Date, endDate: Date }}
     */
    async getCurrentSchoolyear() {
        if (!this.sessionId) {
            throw new Error('Unauthenticated instance');
        }

        const { name, startDate, endDate } = (await WebUntis.request(this.rpcUri, {
            'method': 'POST',
            'headers': {
                'cookie': `JSESSIONID=${this.sessionId}`,
            },
            'body': JSON.stringify(WebUntis.rpcify('getCurrentSchoolyear')),
        })).result;

        if (!name || !startDate || !endDate) {
            throw new Error('Missing response data');
        }

        return { name, startDate: WebUntis.parseUntisDate(startDate),
            endDate: WebUntis.parseUntisDate(endDate) };
    }

    /**
     * @typedef TimetableEntry
     * @type {object}
     * @property {Date} startDate
     * @property {Date} endDate
     * @property {string} subject
     * @property {boolean} cancelled
     */

    /**
     * Gets the timetable of the current user for a given week.
     * 
     * @param {Date} date - any day of the week for which the timetable is
     *                      requested
     * 
     * @returns {TimetableEntry[]}
     */
    async getTimetableWeek(date) {
        if (!date) {
            throw new Error('Insufficient arguments: date required');
        }

        if (!this.sessionId) {
            throw new Error('Unauthenticated instance');
        }

        // Use ISO weeks since they start on mondays
        const mondayInWeek = WebUntis.dateToUntisDate(
            startOfISOWeek(date), '-');

        const uri = `${BASE_URL}/api/public/timetable/weekly/data?`
            + `elementType=5&` // Student timetable, see RPC API spec
            + `elementId=${this.personId}&`
            // Must be the monday of the requested week, otherwise the next week
            // is returned
            + `date=${mondayInWeek}&`
            + `formatId=1` // Untested

        const result = await WebUntis.request(uri, {
            'headers': {
                'accept': 'application/json',
                'accept-language': 'en-US,en;q=0.9',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                // Removed schoolname cookie
                'cookie': `JSESSIONID=${this.sessionId}`,
            },
            'referrer': 'https://erato.webuntis.com/WebUntis/index.do',
            'referrerPolicy': 'no-referrer-when-downgrade',
            'body': null,
            'method': 'GET',
            'mode': 'cors',
        });

        // What
        const data = result.data.result.data;

        // {
        //     type: 1 = klasse, 2 = teachers and others?, 3 = subject, 4 = room,
        //         5 = student,
        //     id: only unique within type
        //     for subjects:
        //     name: name,
        //     longName: long name, never used online?,
        //     ...
        // }
        const rawElements = data.elements;

        // {
        //     date: regular untis date string,
        //     endTime: number, 'HHMM',
        //     startTime: see endTime,
        //     studentGroup: `${shortSubject}_${studentgroups}_${shortTeacher}`,
        //     elements: {
        //         id: element id within a type,
        //         type: element type,
        //         ...
        //     },
        //     ...
        // }
        const rawPeriods = data.elementPeriods[data.elementIds[0]];

        const elements = {};

        // Parse raw elements array into subarrays by type
        for (const rawEl of rawElements) {
            if (!elements[rawEl.type]) {
                elements[rawEl.type] = [ rawEl ];
            } else {
                elements[rawEl.type].push(rawEl);
            }
        }

        // Parse type subarrays into objects with ids as keys
        // Access elements through elements[type][id]
        for (const type in elements) {
            elements[type] = elements[type].reduce((acc, cur) => {
                if (!acc[cur.id])
                    acc[cur.id] = cur;

                return acc;
            }, {});
        }

        const periods = [];

        for (const rawPer of rawPeriods) {
            const endDate = WebUntis.parseUntisDateTime(rawPer.date,
                rawPer.endTime);
            const startDate = WebUntis.parseUntisDateTime(rawPer.date,
                rawPer.startTime);

            periods.push({
                startDate, endDate,
                subject: elements['3']
                    [rawPer.elements.filter((e) => e.type == 3)[0].id].name,
                // This appears to be set even for substituted lessons, not sure
                // if they officially count for the absence rate
                cancelled: rawPer.is.cancelled || false,
            });
        }

        return periods.sort((a, b) => a.startDate - b.startDate);
    }
};

exports.WebUntis = WebUntis;
