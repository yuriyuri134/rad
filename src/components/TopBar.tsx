import { Play } from 'lucide-react';

export type WorkspaceTab = 'experiment' | 'components' | 'compare' | 'architecture';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onQuickRun: () => void;
  isRunning: boolean;
}

const TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'experiment', label: '实验台' },
  { id: 'components', label: '组件库' },
  { id: 'compare', label: '方案对比' },
  { id: 'architecture', label: '架构地图' },
];

export function TopBar({ activeTab, onSelectTab, onQuickRun, isRunning }: TopBarProps) {
  return (
    <header className="bg-white border-b border-slate-200 px-6 h-14 flex items-center justify-between gap-8 sticky top-0 z-30">
      {/* Zone 1: Single text element wordmark */}
      <button
        type="button"
        onClick={() => onSelectTab('experiment')}
        className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600"
      >
        OpenLab Bench
      </button>

      {/* Zone 2: 4 single-line navigation links */}
      <nav aria-label="主工作区导航" className="flex items-center gap-6 overflow-x-auto">
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              aria-current={active ? 'page' : undefined}
              className={`py-4 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 ${
                active
                  ? 'border-blue-700 text-blue-700'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="shrink-0">
        <button
          type="button"
          onClick={onQuickRun}
          disabled={isRunning}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600"
        >
          <Play className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{isRunning ? '求解计算中...' : '运行当前实验'}</span>
        </button>
      </div>
    </header>
  );
}
