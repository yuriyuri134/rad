// 架构地图引擎自描述存根（真实扫描、关系解析与一致性检查逻辑位于 src/core/architectureMap.ts）
// 本组件同时存在于组件库与整体架构地图中，支持进入查看其内部 6 个子模块与有限自引用关系。
export const ARCHITECTURE_MAP_SUBPARTS = [
  { id: 'sub:arch-collector', name: '结构数据采集器 (Collector)', module: 'src/core/architectureMap.ts' },
  { id: 'sub:arch-resolver', name: '关系与溯源解析器 (Relation Resolver)', module: 'src/core/architectureMap.ts' },
  { id: 'sub:arch-layout', name: '分层视图布局器 (Layout Engine)', module: 'src/components/ArchitectureMapView.tsx' },
  { id: 'sub:arch-navigator', name: '局部下钻与面包屑导航 (Navigator)', module: 'src/components/ArchitectureMapView.tsx' },
  { id: 'sub:arch-renderer', name: '图谱与详情渲染器 (Renderer)', module: 'src/components/ArchitectureMapView.tsx' },
  { id: 'sub:arch-checker', name: '一致性与过期检查器 (Integrity Checker)', module: 'src/core/architectureMap.ts' },
];
