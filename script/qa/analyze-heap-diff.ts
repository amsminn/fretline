import { writeFile } from 'node:fs/promises';

type Group = {
  readonly count: number;
  readonly selfBytes: number;
  readonly retainedBytes: number;
  readonly maxRetainedBytes: number;
};
type Analysis = {
  readonly nodeCount: number;
  readonly reachableNodes: number;
  readonly totalSelfBytes: number;
  readonly groups: Readonly<Record<string, Group>>;
  readonly paths: Readonly<Record<string, readonly string[]>>;
};

const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native',
  'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'] as const;
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'] as const;
const nodeFieldCount = 6;
const edgeFieldCount = 3;
const weakEdge = 6;

function parseNumbers(text: string, start: number, end: number, consume: (value: number, index: number) => void): number {
  let value = 0;
  let reading = false;
  let index = 0;
  for (let at = start; at < end; at++) {
    const code = text.charCodeAt(at);
    if (code >= 48 && code <= 57) {
      value = value * 10 + code - 48;
      reading = true;
    } else if (reading) {
      consume(value, index++);
      value = 0;
      reading = false;
    }
  }
  if (reading) consume(value, index++);
  return index;
}

async function analyze(path: string): Promise<Analysis> {
  console.log(`Loading ${path}`);
  let text = await Bun.file(path).text();
  const nodeCountMatch = /"node_count":(\d+)/.exec(text.slice(0, 4096));
  const edgeCountMatch = /"edge_count":(\d+)/.exec(text.slice(0, 4096));
  if (!nodeCountMatch?.[1] || !edgeCountMatch?.[1]) throw new TypeError('Missing heap snapshot counts');
  const nodeCount = Number(nodeCountMatch[1]);
  const edgeCount = Number(edgeCountMatch[1]);
  const nodesKey = text.indexOf('"nodes":[');
  const edgesKey = text.indexOf('"edges":[', nodesKey);
  const traceKey = text.indexOf('"trace_function_infos":', edgesKey);
  const stringsKey = text.indexOf('"strings":[', traceKey);
  const nodesStart = nodesKey + '"nodes":['.length;
  const nodesEnd = text.lastIndexOf(']', edgesKey);
  const edgesStart = edgesKey + '"edges":['.length;
  const edgesEnd = text.lastIndexOf(']', traceKey);
  const stringsStart = stringsKey + '"strings":['.length;
  const stringsEnd = text.lastIndexOf(']');
  if (nodesKey < 0 || edgesKey < 0 || traceKey < 0 || stringsKey < 0 ||
    nodesEnd < nodesStart || edgesEnd < edgesStart || stringsEnd < stringsStart) {
    throw new TypeError('Unexpected heap snapshot layout');
  }

  const names = new Uint32Array(nodeCount);
  const types = new Uint8Array(nodeCount);
  const selfSizes = new Float64Array(nodeCount);
  const edgeOffsets = new Uint32Array(nodeCount + 1);
  let runningEdges = 0;
  const parsedNodeValues = parseNumbers(text, nodesStart, nodesEnd, (value, index) => {
    const node = Math.floor(index / nodeFieldCount);
    switch (index % nodeFieldCount) {
      case 0: types[node] = value; break;
      case 1: names[node] = value; break;
      case 3: selfSizes[node] = value; break;
      case 4:
        edgeOffsets[node] = runningEdges;
        runningEdges += value;
        break;
      default: break;
    }
  });
  edgeOffsets[nodeCount] = runningEdges;
  if (parsedNodeValues !== nodeCount * nodeFieldCount || runningEdges !== edgeCount) {
    throw new TypeError(`Heap node parse mismatch ${parsedNodeValues}/${nodeCount * nodeFieldCount}, ${runningEdges}/${edgeCount}`);
  }

  const edgeTo = new Uint32Array(edgeCount);
  const edgeType = new Uint8Array(edgeCount);
  const edgeName = new Uint32Array(edgeCount);
  const parsedEdgeValues = parseNumbers(text, edgesStart, edgesEnd, (value, index) => {
    const edge = Math.floor(index / edgeFieldCount);
    switch (index % edgeFieldCount) {
      case 0: edgeType[edge] = value; break;
      case 1: edgeName[edge] = value; break;
      case 2: edgeTo[edge] = value / nodeFieldCount; break;
      default: break;
    }
  });
  if (parsedEdgeValues !== edgeCount * edgeFieldCount) {
    throw new TypeError(`Heap edge parse mismatch ${parsedEdgeValues}/${edgeCount * edgeFieldCount}`);
  }
  const strings = JSON.parse(`[${text.slice(stringsStart, stringsEnd)}]`) as string[];
  text = '';

  console.log(`Traversing ${nodeCount} nodes / ${edgeCount} edges`);
  const dfs = new Uint32Array(nodeCount);
  const vertex = new Uint32Array(nodeCount + 1);
  const parent = new Uint32Array(nodeCount + 1);
  const stackNode = new Uint32Array(nodeCount);
  const stackEdge = new Uint32Array(nodeCount);
  let reachable = 1;
  let top = 0;
  dfs[0] = 1;
  vertex[1] = 0;
  stackNode[0] = 0;
  stackEdge[0] = edgeOffsets[0] ?? 0;
  while (top >= 0) {
    const node = stackNode[top] ?? 0;
    const edge = stackEdge[top] ?? 0;
    const end = edgeOffsets[node + 1] ?? 0;
    if (edge >= end) {
      top--;
      continue;
    }
    stackEdge[top] = edge + 1;
    if (edgeType[edge] === weakEdge) continue;
    const child = edgeTo[edge] ?? 0;
    if (dfs[child]) continue;
    const number = ++reachable;
    dfs[child] = number;
    vertex[number] = child;
    parent[number] = dfs[node] ?? 0;
    top++;
    stackNode[top] = child;
    stackEdge[top] = edgeOffsets[child] ?? 0;
  }

  const predecessorCounts = new Uint32Array(reachable + 1);
  for (let number = 1; number <= reachable; number++) {
    const node = vertex[number] ?? 0;
    for (let edge = edgeOffsets[node] ?? 0; edge < (edgeOffsets[node + 1] ?? 0); edge++) {
      if (edgeType[edge] === weakEdge) continue;
      const childNumber = dfs[edgeTo[edge] ?? 0] ?? 0;
      if (childNumber) predecessorCounts[childNumber] = (predecessorCounts[childNumber] ?? 0) + 1;
    }
  }
  const predecessorOffsets = new Uint32Array(reachable + 2);
  for (let number = 1; number <= reachable; number++) {
    predecessorOffsets[number + 1] = (predecessorOffsets[number] ?? 0) + (predecessorCounts[number] ?? 0);
  }
  const predecessors = new Uint32Array(predecessorOffsets[reachable + 1] ?? 0);
  const predecessorCursor = predecessorOffsets.slice();
  for (let number = 1; number <= reachable; number++) {
    const node = vertex[number] ?? 0;
    for (let edge = edgeOffsets[node] ?? 0; edge < (edgeOffsets[node + 1] ?? 0); edge++) {
      if (edgeType[edge] === weakEdge) continue;
      const childNumber = dfs[edgeTo[edge] ?? 0] ?? 0;
      if (!childNumber) continue;
      const at = predecessorCursor[childNumber] ?? 0;
      predecessors[at] = number;
      predecessorCursor[childNumber] = at + 1;
    }
  }

  console.log(`Computing dominators for ${reachable} reachable nodes`);
  const semi = new Uint32Array(reachable + 1);
  const label = new Uint32Array(reachable + 1);
  const ancestor = new Uint32Array(reachable + 1);
  const idom = new Uint32Array(reachable + 1);
  const bucketHead = new Uint32Array(reachable + 1);
  const bucketNext = new Uint32Array(reachable + 1);
  for (let number = 1; number <= reachable; number++) {
    semi[number] = number;
    label[number] = number;
  }
  const compressionPath: number[] = [];
  const evaluate = (value: number): number => {
    if (!(ancestor[value] ?? 0)) return label[value] ?? value;
    compressionPath.length = 0;
    let cursor = value;
    while (ancestor[ancestor[cursor] ?? 0] ?? 0) {
      compressionPath.push(cursor);
      cursor = ancestor[cursor] ?? 0;
    }
    for (let index = compressionPath.length - 1; index >= 0; index--) {
      const node = compressionPath[index] ?? 0;
      const parentNode = ancestor[node] ?? 0;
      const parentLabel = label[parentNode] ?? parentNode;
      const nodeLabel = label[node] ?? node;
      if ((semi[parentLabel] ?? parentLabel) < (semi[nodeLabel] ?? nodeLabel)) label[node] = parentLabel;
      ancestor[node] = ancestor[parentNode] ?? 0;
    }
    return label[value] ?? value;
  };
  for (let current = reachable; current >= 2; current--) {
    for (let at = predecessorOffsets[current] ?? 0; at < (predecessorOffsets[current + 1] ?? 0); at++) {
      const candidate = evaluate(predecessors[at] ?? 0);
      if ((semi[candidate] ?? candidate) < (semi[current] ?? current)) semi[current] = semi[candidate] ?? candidate;
    }
    bucketNext[current] = bucketHead[semi[current] ?? 0] ?? 0;
    bucketHead[semi[current] ?? 0] = current;
    ancestor[current] = parent[current] ?? 0;
    let bucket = bucketHead[parent[current] ?? 0] ?? 0;
    bucketHead[parent[current] ?? 0] = 0;
    while (bucket) {
      const next = bucketNext[bucket] ?? 0;
      const candidate = evaluate(bucket);
      idom[bucket] = (semi[candidate] ?? candidate) < (semi[bucket] ?? bucket) ? candidate : (parent[current] ?? 0);
      bucket = next;
    }
  }
  for (let current = 2; current <= reachable; current++) {
    if (idom[current] !== semi[current]) idom[current] = idom[idom[current] ?? 0] ?? 0;
  }

  const retained = new Float64Array(nodeCount);
  let totalSelfBytes = 0;
  for (let current = 1; current <= reachable; current++) {
    const node = vertex[current] ?? 0;
    retained[node] = selfSizes[node] ?? 0;
    totalSelfBytes += selfSizes[node] ?? 0;
  }
  for (let current = reachable; current >= 2; current--) {
    const node = vertex[current] ?? 0;
    const owner = vertex[idom[current] ?? 0] ?? 0;
    retained[owner] = (retained[owner] ?? 0) + (retained[node] ?? 0);
  }

  const groups = new Map<string, Group & { maxNode: number }>();
  for (let current = 1; current <= reachable; current++) {
    const node = vertex[current] ?? 0;
    const name = strings[names[node] ?? 0] ?? '(missing)';
    const type = nodeTypes[types[node] ?? 0] ?? 'unknown';
    const key = type === 'object' || type === 'native' || type === 'closure' ? name : `${type}:${name}`;
    const previous = groups.get(key) ?? { count: 0, selfBytes: 0, retainedBytes: 0, maxRetainedBytes: 0, maxNode: node };
    const retainedBytes = retained[node] ?? 0;
    groups.set(key, {
      count: previous.count + 1,
      selfBytes: previous.selfBytes + (selfSizes[node] ?? 0),
      retainedBytes: previous.retainedBytes + retainedBytes,
      maxRetainedBytes: Math.max(previous.maxRetainedBytes, retainedBytes),
      maxNode: retainedBytes > previous.maxRetainedBytes ? node : previous.maxNode,
    });
  }
  const edgeLabel = (edge: number): string => {
    const type = edgeTypes[edgeType[edge] ?? 0] ?? 'unknown';
    const name = type === 'element' ? String(edgeName[edge] ?? 0) : strings[edgeName[edge] ?? 0] ?? '(missing)';
    return `${type}:${name}`;
  };
  const pathFor = (node: number): string[] => {
    const steps: string[] = [];
    let current = dfs[node] ?? 0;
    while (current > 1 && steps.length < 100) {
      const ownerNumber = idom[current] ?? 0;
      const owner = vertex[ownerNumber] ?? 0;
      const child = vertex[current] ?? 0;
      let labelText = '(dominator)';
      for (let edge = edgeOffsets[owner] ?? 0; edge < (edgeOffsets[owner + 1] ?? 0); edge++) {
        if (edgeTo[edge] === child && edgeType[edge] !== weakEdge) {
          labelText = edgeLabel(edge);
          break;
        }
      }
      const ownerName = strings[names[owner] ?? 0] ?? '(missing)';
      const childName = strings[names[child] ?? 0] ?? '(missing)';
      steps.push(`${ownerName} --${labelText}--> ${childName}`);
      current = ownerNumber;
    }
    return steps.reverse();
  };
  const paths: Record<string, readonly string[]> = {};
  for (const [name, group] of [...groups].sort((left, right) => right[1].retainedBytes - left[1].retainedBytes).slice(0, 100)) {
    paths[name] = pathFor(group.maxNode);
  }
  return {
    nodeCount,
    reachableNodes: reachable,
    totalSelfBytes,
    groups: Object.fromEntries([...groups].map(([name, group]) => [name, {
      count: group.count,
      selfBytes: group.selfBytes,
      retainedBytes: group.retainedBytes,
      maxRetainedBytes: group.maxRetainedBytes,
    }])),
    paths,
  };
}

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !outputPath) {
  throw new TypeError('Usage: bun script/qa/analyze-heap-diff.ts <before.heapsnapshot> <after.heapsnapshot> <output.json>');
}
const before = await analyze(beforePath);
Bun.gc(true);
const after = await analyze(afterPath);
const names = new Set([...Object.keys(before.groups), ...Object.keys(after.groups)]);
const differences = [...names].map(name => {
  const left = before.groups[name] ?? { count: 0, selfBytes: 0, retainedBytes: 0, maxRetainedBytes: 0 };
  const right = after.groups[name] ?? { count: 0, selfBytes: 0, retainedBytes: 0, maxRetainedBytes: 0 };
  return {
    name,
    countBefore: left.count,
    countAfter: right.count,
    countDelta: right.count - left.count,
    selfBytesBefore: left.selfBytes,
    selfBytesAfter: right.selfBytes,
    selfBytesDelta: right.selfBytes - left.selfBytes,
    retainedBytesBefore: left.retainedBytes,
    retainedBytesAfter: right.retainedBytes,
    retainedBytesDelta: right.retainedBytes - left.retainedBytes,
    maxRetainedBytesBefore: left.maxRetainedBytes,
    maxRetainedBytesAfter: right.maxRetainedBytes,
  };
}).sort((left, right) => right.retainedBytesDelta - left.retainedBytesDelta);
const relevant = differences.filter(item => !item.name.startsWith('synthetic:'));
const largest = relevant[0];
await writeFile(outputPath, JSON.stringify({
  before: {
    nodeCount: before.nodeCount,
    reachableNodes: before.reachableNodes,
    totalSelfBytes: before.totalSelfBytes,
  },
  after: {
    nodeCount: after.nodeCount,
    reachableNodes: after.reachableNodes,
    totalSelfBytes: after.totalSelfBytes,
  },
  top15ByRetainedGrowth: relevant.slice(0, 15),
  top15BySelfGrowth: [...differences].sort((left, right) => right.selfBytesDelta - left.selfBytesDelta).slice(0, 15),
  largestGrowingClassRetainerPath: largest ? { name: largest.name, path: after.paths[largest.name] ?? [] } : null,
}, null, 2));
console.log(`Wrote ${outputPath}`);
