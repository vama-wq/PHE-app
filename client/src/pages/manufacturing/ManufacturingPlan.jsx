import { useEffect, useState, useMemo } from 'react';
import api from '../../lib/api';
import { PRODUCTION_STAGES } from '../../lib/utils';
import { Calendar, Settings, ChevronLeft, ChevronRight, AlertTriangle, CheckCircle, Clock, Filter } from 'lucide-react';

const WORK_HOURS_PER_DAY = 10.5; // 9am-7:30pm
const BUFFER_DAYS = 2;

const DEFAULT_STAGE_HOURS = {
  1: 4, 2: 3, 3: 2, 4: 3, 5: 3, 6: 6, 7: 1, 8: 8, 9: 1, 10: 4,
  11: 3, 12: 6, 13: 3, 14: 6, 15: 4, 16: 8, 17: 8, 18: 3, 19: 10.5,
  20: 1, 21: 3, 22: 3, 23: 4, 24: 1, 25: 3, 26: 2, 27: 1, 28: 2, 29: 2,
};

function loadDurations() {
  try {
    const saved = localStorage.getItem('mfg_stage_durations');
    if (saved) return { ...DEFAULT_STAGE_HOURS, ...JSON.parse(saved) };
  } catch {}
  return { ...DEFAULT_STAGE_HOURS };
}

function saveDurations(d) {
  localStorage.setItem('mfg_stage_durations', JSON.stringify(d));
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function diffDays(a, b) {
  return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000);
}

function formatDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function getWeekDates(baseDate) {
  const d = new Date(baseDate + 'T00:00:00');
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(mon);
    dd.setDate(mon.getDate() + i);
    dates.push(dd.toISOString().split('T')[0]);
  }
  return dates;
}

function scheduleJobCard(jc, stageData, durations, applicableStages) {
  const deadline = addDays(jc.dispatch_date, -BUFFER_DAYS);
  const stageMap = {};
  stageData.forEach(s => { stageMap[s.stage_no] = s; });

  const pendingStages = applicableStages.filter(stNo => {
    const sd = stageMap[stNo];
    return !sd || !sd.done;
  });

  if (pendingStages.length === 0) return { jc, assignments: [], isComplete: true };

  const totalHours = pendingStages.reduce((sum, stNo) => sum + (durations[stNo] || 2), 0);
  const totalDays = Math.ceil(totalHours / WORK_HOURS_PER_DAY);

  let currentDate = addDays(deadline, -totalDays + 1);
  const today = new Date().toISOString().split('T')[0];
  if (currentDate < today) currentDate = today;

  const assignments = [];
  let dayHoursLeft = WORK_HOURS_PER_DAY;

  for (const stNo of pendingStages) {
    const stageDef = PRODUCTION_STAGES.find(s => s.no === stNo);
    let hoursNeeded = durations[stNo] || 2;

    while (hoursNeeded > 0) {
      const hoursToday = Math.min(hoursNeeded, dayHoursLeft);
      assignments.push({
        date: currentDate,
        stageNo: stNo,
        stageName: stageDef?.name || `Stage ${stNo}`,
        hours: hoursToday,
        jobCardId: jc.id,
        jobCardNo: jc.job_card_no,
        customerCode: jc.customer_code,
        productName: jc.product_name,
        qty: jc.qty,
        dispatchDate: jc.dispatch_date,
      });
      hoursNeeded -= hoursToday;
      dayHoursLeft -= hoursToday;
      if (dayHoursLeft <= 0) {
        currentDate = addDays(currentDate, 1);
        dayHoursLeft = WORK_HOURS_PER_DAY;
      }
    }
  }

  const lastAssignmentDate = assignments.length > 0 ? assignments[assignments.length - 1].date : null;
  const isLate = lastAssignmentDate && lastAssignmentDate > deadline;

  return { jc, assignments, isComplete: false, isLate, deadline, lastDate: lastAssignmentDate };
}

export default function ManufacturingPlan() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [durations, setDurations] = useState(loadDurations);
  const [showSettings, setShowSettings] = useState(false);
  const [viewMode, setViewMode] = useState('daily');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [filterJC, setFilterJC] = useState('');

  useEffect(() => {
    api.get('/manufacturing/planning-data')
      .then(r => setData(r.data))
      .catch(err => setError(`${err.response?.status || ''} ${err.response?.data?.error || err.message || 'Unknown error'}`))
      .finally(() => setLoading(false));
  }, []);

  const schedules = useMemo(() => {
    if (!data) return [];
    const { cards, stages } = data;
    const stagesByCard = {};
    stages.forEach(s => {
      if (!stagesByCard[s.job_card_id]) stagesByCard[s.job_card_id] = [];
      stagesByCard[s.job_card_id].push(s);
    });

    return cards.map(jc => {
      const jcStages = stagesByCard[jc.id] || [];
      const doneStageNos = new Set(jcStages.filter(s => s.done).map(s => s.stage_no));
      const applicableStages = PRODUCTION_STAGES
        .filter(s => !s.optional || doneStageNos.has(s.no))
        .map(s => s.no);
      const allStages = PRODUCTION_STAGES.map(s => s.no);
      return scheduleJobCard(jc, jcStages, durations, applicableStages.length > 0 ? applicableStages : allStages);
    });
  }, [data, durations]);

  const dailyPlan = useMemo(() => {
    const map = {};
    schedules.forEach(sch => {
      sch.assignments.forEach(a => {
        if (!map[a.date]) map[a.date] = [];
        map[a.date].push(a);
      });
    });
    return map;
  }, [schedules]);

  const todayTasks = dailyPlan[selectedDate] || [];
  const weekDates = getWeekDates(selectedDate);

  const filteredTasks = filterJC
    ? todayTasks.filter(t => t.jobCardNo.toLowerCase().includes(filterJC.toLowerCase()) || t.customerCode.toLowerCase().includes(filterJC.toLowerCase()))
    : todayTasks;

  const tasksByJC = {};
  filteredTasks.forEach(t => {
    if (!tasksByJC[t.jobCardId]) tasksByJC[t.jobCardId] = { ...t, stages: [] };
    tasksByJC[t.jobCardId].stages.push(t);
  });

  const handleDurationChange = (stageNo, val) => {
    const updated = { ...durations, [stageNo]: parseFloat(val) || 0 };
    setDurations(updated);
    saveDurations(updated);
  };

  const stats = useMemo(() => {
    const late = schedules.filter(s => s.isLate).length;
    const onTrack = schedules.filter(s => !s.isLate && !s.isComplete).length;
    const complete = schedules.filter(s => s.isComplete).length;
    const totalJCs = schedules.length;
    return { late, onTrack, complete, totalJCs };
  }, [schedules]);

  if (loading) return <div className="p-8 text-center text-gray-400">Loading manufacturing data...</div>;
  if (!data) return <div className="p-8 text-center text-red-500">Failed to load data{error ? `: ${error}` : ''}</div>;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Calendar size={24} className="text-brand-600" /> Manufacturing Plan
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Daily production schedule based on dispatch deadlines · {WORK_HOURS_PER_DAY}h/day · {BUFFER_DAYS}-day buffer
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowSettings(!showSettings)}
            className={`btn-secondary btn-sm ${showSettings ? 'bg-brand-50 border-brand-300' : ''}`}>
            <Settings size={14} /> Stage Durations
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="card p-4">
          <p className="text-xs text-gray-500 font-medium uppercase">Active Job Cards</p>
          <p className="text-2xl font-bold text-gray-900">{stats.totalJCs}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-green-600 font-medium uppercase">On Track</p>
          <p className="text-2xl font-bold text-green-600">{stats.onTrack}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-red-600 font-medium uppercase">Behind Schedule</p>
          <p className="text-2xl font-bold text-red-600">{stats.late}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-blue-600 font-medium uppercase">Production Complete</p>
          <p className="text-2xl font-bold text-blue-600">{stats.complete}</p>
        </div>
      </div>

      {/* Stage Duration Settings */}
      {showSettings && (
        <div className="card p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="section-title">Stage Duration Defaults (hours per batch)</h2>
            <button onClick={() => { setDurations({ ...DEFAULT_STAGE_HOURS }); saveDurations(DEFAULT_STAGE_HOURS); }}
              className="btn-ghost btn-sm text-xs">Reset to Defaults</button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {PRODUCTION_STAGES.map(s => (
              <div key={s.no} className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <label className="text-xs text-gray-600 truncate block">{s.no}. {s.name}</label>
                  <input type="number" step="0.5" min="0.5" className="input text-sm py-1.5 mt-0.5"
                    value={durations[s.no] || ''} onChange={e => handleDurationChange(s.no, e.target.value)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* View Toggle + Date Nav */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
          <button onClick={() => setViewMode('daily')}
            className={`px-4 py-2 rounded-md text-sm font-medium ${viewMode === 'daily' ? 'bg-white shadow-sm text-brand-700' : 'text-gray-500'}`}>
            Daily Plan
          </button>
          <button onClick={() => setViewMode('week')}
            className={`px-4 py-2 rounded-md text-sm font-medium ${viewMode === 'week' ? 'bg-white shadow-sm text-brand-700' : 'text-gray-500'}`}>
            Week View
          </button>
          <button onClick={() => setViewMode('timeline')}
            className={`px-4 py-2 rounded-md text-sm font-medium ${viewMode === 'timeline' ? 'bg-white shadow-sm text-brand-700' : 'text-gray-500'}`}>
            Job Card Timeline
          </button>
        </div>
        <div className="flex items-center gap-2">
          {viewMode !== 'timeline' && (
            <>
              <button onClick={() => setSelectedDate(addDays(selectedDate, viewMode === 'week' ? -7 : -1))}
                className="btn-ghost btn-sm"><ChevronLeft size={16} /></button>
              <button onClick={() => setSelectedDate(new Date().toISOString().split('T')[0])}
                className="btn-secondary btn-sm text-xs">Today</button>
              <span className="text-sm font-semibold text-gray-700 min-w-[140px] text-center">{formatDate(selectedDate)}</span>
              <button onClick={() => setSelectedDate(addDays(selectedDate, viewMode === 'week' ? 7 : 1))}
                className="btn-ghost btn-sm"><ChevronRight size={16} /></button>
            </>
          )}
        </div>
      </div>

      {/* Daily Plan View */}
      {viewMode === 'daily' && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-xs">
              <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input className="input pl-9 py-2" placeholder="Filter by Job Card or Customer..."
                value={filterJC} onChange={e => setFilterJC(e.target.value)} />
            </div>
            <span className="text-sm text-gray-500">
              {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''} · {Object.keys(tasksByJC).length} job card{Object.keys(tasksByJC).length !== 1 ? 's' : ''}
            </span>
          </div>

          {Object.keys(tasksByJC).length === 0 ? (
            <div className="card p-12 text-center text-gray-400">
              <Calendar size={40} className="mx-auto mb-3 opacity-40" />
              <p className="font-medium">No tasks scheduled for {formatDate(selectedDate)}</p>
              <p className="text-sm mt-1">Try navigating to another date or check the week view</p>
            </div>
          ) : (
            <div className="space-y-4">
              {Object.values(tasksByJC).map(group => {
                const sch = schedules.find(s => s.jc.id === group.jobCardId);
                const totalHoursToday = group.stages.reduce((sum, s) => sum + s.hours, 0);
                return (
                  <div key={group.jobCardId} className="card overflow-hidden">
                    <div className={`px-5 py-3 border-b flex items-center justify-between ${
                      sch?.isLate ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'
                    }`}>
                      <div className="flex items-center gap-3">
                        <span className="font-bold text-gray-900">{group.jobCardNo}</span>
                        <span className="text-sm text-gray-500">{group.customerCode}</span>
                        {group.productName && <span className="text-sm text-gray-400">· {group.productName}</span>}
                        <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">{group.qty} Nos</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {sch?.isLate && (
                          <span className="text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded-full flex items-center gap-1">
                            <AlertTriangle size={12} /> Behind schedule
                          </span>
                        )}
                        <span className="text-xs text-gray-500">
                          <Clock size={12} className="inline mr-1" />{totalHoursToday.toFixed(1)}h today
                        </span>
                        <span className="text-xs text-gray-500">
                          Dispatch: {formatDate(group.dispatchDate)}
                        </span>
                      </div>
                    </div>
                    <div className="px-5 py-3">
                      <div className="flex flex-wrap gap-2">
                        {group.stages.map((s, i) => (
                          <div key={i} className="flex items-center gap-2 px-3 py-2 bg-brand-50 border border-brand-200 rounded-lg">
                            <span className="text-xs font-bold text-brand-700">S{s.stageNo}</span>
                            <span className="text-sm text-gray-800">{s.stageName}</span>
                            <span className="text-xs text-gray-500">({s.hours.toFixed(1)}h)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Week View */}
      {viewMode === 'week' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {weekDates.map(d => {
                    const isToday = d === new Date().toISOString().split('T')[0];
                    const isSelected = d === selectedDate;
                    return (
                      <th key={d} className={`table-header text-center min-w-[140px] cursor-pointer ${
                        isToday ? 'bg-brand-50 text-brand-700' : ''
                      } ${isSelected ? 'ring-2 ring-brand-400 ring-inset' : ''}`}
                        onClick={() => { setSelectedDate(d); setViewMode('daily'); }}>
                        {formatDate(d)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {weekDates.map(d => {
                    const tasks = dailyPlan[d] || [];
                    const byJC = {};
                    tasks.forEach(t => {
                      if (!byJC[t.jobCardId]) byJC[t.jobCardId] = { ...t, stages: [] };
                      byJC[t.jobCardId].stages.push(t);
                    });
                    const totalHours = tasks.reduce((sum, t) => sum + t.hours, 0);
                    const utilization = Math.round((totalHours / WORK_HOURS_PER_DAY) * 100);
                    return (
                      <td key={d} className="p-2 align-top border-r border-gray-100 min-w-[140px]">
                        <div className="mb-2">
                          <div className="flex justify-between items-center text-xs text-gray-500 mb-1">
                            <span>{Object.keys(byJC).length} JC{Object.keys(byJC).length !== 1 ? 's' : ''}</span>
                            <span>{totalHours.toFixed(1)}h</span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-1.5">
                            <div className={`h-full rounded-full ${utilization > 100 ? 'bg-red-500' : utilization > 80 ? 'bg-amber-500' : 'bg-green-500'}`}
                              style={{ width: `${Math.min(utilization, 100)}%` }} />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          {Object.values(byJC).map(group => (
                            <div key={group.jobCardId}
                              className="p-2 bg-brand-50 border border-brand-100 rounded-md text-xs cursor-pointer hover:bg-brand-100"
                              onClick={() => { setSelectedDate(d); setViewMode('daily'); }}>
                              <div className="font-bold text-gray-800">{group.jobCardNo}</div>
                              <div className="text-gray-500 truncate">{group.customerCode}</div>
                              <div className="mt-1 text-brand-700">
                                {group.stages.map(s => `S${s.stageNo}`).join(', ')}
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Timeline View */}
      {viewMode === 'timeline' && (
        <div className="space-y-3">
          {schedules.filter(s => !s.isComplete).map(sch => {
            const today = new Date().toISOString().split('T')[0];
            const totalDays = sch.assignments.length > 0
              ? diffDays(sch.lastDate, sch.assignments[0].date) + 1
              : 0;
            const daysLeft = diffDays(sch.jc.dispatch_date, today);
            const stagesByDate = {};
            sch.assignments.forEach(a => {
              if (!stagesByDate[a.date]) stagesByDate[a.date] = [];
              if (!stagesByDate[a.date].includes(a.stageNo)) stagesByDate[a.date].push(a.stageNo);
            });
            const uniqueDates = Object.keys(stagesByDate).sort();

            return (
              <div key={sch.jc.id} className="card overflow-hidden">
                <div className={`px-5 py-3 border-b flex items-center justify-between ${
                  sch.isLate ? 'bg-red-50 border-red-200' : 'bg-gray-50 border-gray-200'
                }`}>
                  <div className="flex items-center gap-3">
                    {sch.isLate
                      ? <AlertTriangle size={16} className="text-red-500" />
                      : <CheckCircle size={16} className="text-green-500" />}
                    <span className="font-bold text-gray-900">{sch.jc.job_card_no}</span>
                    <span className="text-sm text-gray-500">{sch.jc.customer_code}</span>
                    {sch.jc.product_name && <span className="text-sm text-gray-400">· {sch.jc.product_name}</span>}
                    <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">{sch.jc.qty} Nos</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-gray-500">{totalDays} production day{totalDays !== 1 ? 's' : ''}</span>
                    <span className={`font-semibold ${daysLeft < 0 ? 'text-red-600' : daysLeft <= 3 ? 'text-amber-600' : 'text-green-600'}`}>
                      {daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d to dispatch`}
                    </span>
                  </div>
                </div>
                <div className="px-5 py-3">
                  <div className="flex gap-1.5 flex-wrap">
                    {uniqueDates.map(d => {
                      const stNos = stagesByDate[d];
                      const isPast = d < today;
                      const isToday = d === today;
                      return (
                        <div key={d} className={`px-2.5 py-1.5 rounded-md text-xs border ${
                          isToday ? 'bg-brand-100 border-brand-300 ring-2 ring-brand-400' :
                          isPast ? 'bg-gray-100 border-gray-200 text-gray-400' :
                          'bg-white border-gray-200'
                        }`}>
                          <div className="font-semibold text-gray-600 mb-0.5">{formatDate(d)}</div>
                          <div className="text-brand-700">{stNos.map(n => `S${n}`).join(', ')}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
          {schedules.filter(s => !s.isComplete).length === 0 && (
            <div className="card p-12 text-center text-gray-400">
              <CheckCircle size={40} className="mx-auto mb-3 text-green-400" />
              <p className="font-medium">All job cards have completed production</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
