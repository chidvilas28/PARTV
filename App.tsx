import React, { useState, useEffect, useRef } from 'react';
import { MapCanvas } from './components/MapCanvas';
import { Controls } from './components/Controls';
import { Tutorial } from './components/Tutorial';
import { parseOSMData, pointToLngLat, lngLatToPoint } from './services/graphUtils';
import { findPath, addCustomAlgorithm, getCustomAlgorithms } from './services/algorithms';
import { fetchOverpassData } from './services/overpass';
import { GraphData, AlgorithmType, InteractionMode, Viewport, CustomAlgorithm } from './types';

console.log('PARTV: App component initializing');

/**
 * App.tsx
 * 
 * The Root Component. Acts as the Controller for the application.
 * Responsibilities:
 * 1. Manages global state (Graph data, User selections, UI state).
 * 2. Coordinates the Pathfinding Algorithm execution.
 * 3. Runs the Animation Loop to visualize the algorithm.
 */
const App: React.FC = () => {
  // --- STATE MANAGEMENT ---

  // Camera State: Controls the "viewport" (Lat/Lon/Zoom)
  const [viewport, setViewport] = useState<Viewport>({ lat: 20, lon: 0, zoom: 2 });
  
  // UI State: Appearance and Overlays
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return true;
  });
  const [appMode, setAppMode] = useState<'normal' | 'dev'>('normal');
  const [showTutorial, setShowTutorial] = useState(false);
  const [customAlgorithms, setCustomAlgorithms] = useState<CustomAlgorithm[]>([]);
  
  // Data State: The actual graph structure (Nodes and Edges)
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  // Logic State: Algorithm choices and user selections
  const [algorithm, setAlgorithm] = useState<string>(AlgorithmType.A_STAR);
  const [mode, setMode] = useState<InteractionMode>(InteractionMode.SELECT_START);
  const [startNode, setStartNode] = useState<string | null>(null);
  const [endNode, setEndNode] = useState<string | null>(null);
  const [waypointNode, setWaypointNode] = useState<string | null>(null);
  const [blockedEdges, setBlockedEdges] = useState<Set<string>>(new Set());
  
  // Visualization State: These update rapidly during animation to draw the "Explored" areas
  const [path, setPath] = useState<string[]>([]);
  const [visitedNodes, setVisitedNodes] = useState<Set<string>>(new Set());
  const [visitedParents, setVisitedParents] = useState<Map<string, string>>(new Map());

  // Animation Control State
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [speed, setSpeed] = useState(10); 
  const [stats, setStats] = useState<{distance: number, time: number, visited: number} | null>(null);

  // --- REFS (Mutable State) ---
  // We use refs for data that is needed inside the setInterval loop (Closure trap avoidance)
  // or large datasets we don't want to trigger re-renders for until necessary.
  const fullVisitedOrderRef = useRef<string[]>([]); // The complete list of nodes to animate
  const splitIndexRef = useRef<number>(0);          // Used for Waypoint logic (Leg 1 vs Leg 2)
  const previousMapsRef = useRef<Map<string, string>[]>([]); // Parent maps for reconstruction
  const fullPathRef = useRef<string[]>([]);         // The final solution path
  const leg1PathRef = useRef<string[]>([]);         // Path to waypoint (for intermediate visual)
  const statsRef = useRef<{distance: number, time: number, visited: number} | null>(null);
  const currentIdxRef = useRef<number>(0);          // Animation cursor
  const hasResetForWaypointRef = useRef<boolean>(false);

  // --- HANDLERS ---

  /**
   * Resets the visual state (clears the lines drawn by the algorithm).
   * Does NOT reset the graph or user selections (Start/End points).
   */
  const handleReset = () => {
    setIsRunning(false);
    setIsPaused(false);
    setPath([]);
    setVisitedNodes(new Set());
    setVisitedParents(new Map());
    setStats(null);
    currentIdxRef.current = 0;
    fullVisitedOrderRef.current = [];
    hasResetForWaypointRef.current = false;
  };

  const handleClearBlockages = () => {
      setBlockedEdges(new Set());
      handleReset();
  }

  const handleClearCache = () => {
    setGraph(null);
    setStartNode(null);
    setEndNode(null);
    setWaypointNode(null);
    setBlockedEdges(new Set());
    handleReset();
  };

  // Handlers for File Upload and Overpass API are wrappers around service functions
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      // Timeout allows UI to update to "Loading" state before heavy parsing blocks thread
      setTimeout(() => {
        try {
            const newGraph = parseOSMData(text);
            if (newGraph.nodes.size === 0) {
                alert("No road network nodes found in this file.");
                return;
            }
            newGraph.isCustom = true;
            setGraph(newGraph);
            setStartNode(null);
            setEndNode(null);
            setWaypointNode(null);
            handleReset();
            setBlockedEdges(new Set());
            // Center camera on the new graph
            const midLat = (newGraph.bounds.minLat + newGraph.bounds.maxLat) / 2;
            const midLon = (newGraph.bounds.minLon + newGraph.bounds.maxLon) / 2;
            setViewport({ lat: midLat, lon: midLon, zoom: 15 });
        } catch (err) {
            console.error("XML Parsing Error:", err);
            alert("Failed to parse OSM file.");
        } finally {
            setIsLoading(false);
        }
      }, 50);
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset input
  };

  const handleCustomAlgorithmUpload = (name: string, code: string) => {
    try {
      addCustomAlgorithm(name, code);
      setCustomAlgorithms(getCustomAlgorithms());
      return true;
    } catch (err) {
      return false;
    }
  };

  const handleFetchRoads = async () => {
      if (viewport.zoom < 12.0) {
          alert("Zoom in closer to load roads (Level 12+).");
          return null;
      }
      setIsLoading(true);
      // Calculate bounding box of current screen
      const w = window.innerWidth;
      const h = window.innerHeight;
      const centerP = lngLatToPoint(viewport.lon, viewport.lat, viewport.zoom);
      const p1 = pointToLngLat(centerP.x - w/2, centerP.y - h/2, viewport.zoom);
      const p2 = pointToLngLat(centerP.x + w/2, centerP.y + h/2, viewport.zoom);
      
      let south = Math.min(p1.lat, p2.lat);
      let north = Math.max(p1.lat, p2.lat);
      let west = Math.min(p1.lon, p2.lon);
      let east = Math.max(p1.lon, p2.lon);
      
      // Clamp bounds
      south = Math.max(-90, Math.min(90, south));
      north = Math.max(-90, Math.min(90, north));
      const normalizeLon = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;
      west = normalizeLon(west);
      east = normalizeLon(east);
      if (west > east) east = 180; // Handle anti-meridian edge case crudely
      
      const boundsStr = `${south.toFixed(5)},${west.toFixed(5)},${north.toFixed(5)},${east.toFixed(5)}`;
      try {
          const xmlData = await fetchOverpassData(boundsStr);
          const newGraph = parseOSMData(xmlData);
          if (newGraph.nodes.size === 0) {
            alert("No roads found in this area.");
            return null;
          } else {
            setGraph(newGraph);
            setStartNode(null);
            setEndNode(null);
            setWaypointNode(null);
            handleReset();
            setBlockedEdges(new Set());
            return newGraph;
          }
      } catch (err: any) {
          console.error("Overpass Fetch Error:", err);
          alert(`Failed to download map data: ${err.message || "Unknown error"}`);
          return null;
      } finally {
          setIsLoading(false);
      }
  }

  /**
   * Main Execution Function.
   * 1. Runs the algorithm synchronously (it's fast enough for these graph sizes).
   * 2. Stores the results (path, visited order) in Refs.
   * 3. Sets isRunning=true to trigger the Animation Loop Effect.
   */
  const runVisualization = () => {
    if (!graph || !startNode || !endNode) {
      alert("Please set Start and Target points.");
      return;
    }
    
    handleReset();
    setIsRunning(true);
    setIsPaused(false);

    let fullPath: string[] = [];
    let leg1Path: string[] = [];
    let fullVisitedOrder: string[] = [];
    let splitIndex = 0;
    let previousMaps: Map<string, string>[] = [];
    let statsData = { distance: 0, time: 0, visited: 0 };

    // Logic to handle Waypoints (Split into two algorithm runs)
    if (waypointNode) {
        // Run Leg 1: Start -> Waypoint
        const leg1 = findPath(graph, startNode, waypointNode, algorithm, blockedEdges);
        // Run Leg 2: Waypoint -> End
        const leg2 = findPath(graph, waypointNode, endNode, algorithm, blockedEdges);

        if ((leg1.path.length === 0 && startNode !== waypointNode) || (leg2.path.length === 0 && waypointNode !== endNode)) {
            alert("No path found connecting the points!");
            setIsRunning(false);
            return;
        }

        // Combine results
        fullVisitedOrder = [...leg1.visitedOrder, ...leg2.visitedOrder];
        splitIndex = leg1.visitedOrder.length;
        previousMaps = [leg1.previous, leg2.previous];
        leg1Path = leg1.path;
        
        // Stitch paths
        if (leg1.path.length > 0 && leg2.path.length > 0) {
            fullPath = [...leg1.path, ...leg2.path.slice(1)];
        } else if (leg1.path.length > 0) {
            fullPath = leg1.path;
        } else {
            fullPath = leg2.path;
        }

        statsData = {
            distance: leg1.totalDistance + leg2.totalDistance,
            time: leg1.executionTime + leg2.executionTime,
            visited: fullVisitedOrder.length
        };
    } else {
        // Standard single leg run
        const result = findPath(graph, startNode, endNode, algorithm, blockedEdges);
        if (result.path.length === 0 && startNode !== endNode) {
            alert("No path found!");
            setIsRunning(false);
            return;
        }
        fullVisitedOrder = result.visitedOrder;
        splitIndex = fullVisitedOrder.length;
        previousMaps = [result.previous];
        fullPath = result.path;
        statsData = {
            distance: result.totalDistance,
            time: result.executionTime,
            visited: result.visitedOrder.length
        };
    }

    // Store in refs for the animation loop
    fullVisitedOrderRef.current = fullVisitedOrder;
    splitIndexRef.current = splitIndex;
    previousMapsRef.current = previousMaps;
    fullPathRef.current = fullPath;
    leg1PathRef.current = leg1Path;
    statsRef.current = statsData;
    currentIdxRef.current = 0;
    hasResetForWaypointRef.current = false;
  };

  const togglePause = () => {
    if (isRunning) setIsPaused(prev => !prev);
  };

  /**
   * Animation Loop Effect.
   * Runs continuously while isRunning=true and !isPaused.
   * Updates the `visitedNodes` state in batches to visualize progress.
   */
  useEffect(() => {
    if (!isRunning || isPaused || fullVisitedOrderRef.current.length === 0) return;

    const intervalId = window.setInterval(() => {
        const totalVisited = fullVisitedOrderRef.current.length;
        // Batch size optimization: Higher speed = Larger chunks of nodes processed per frame
        // Power function gives non-linear acceleration for higher speeds
        const batchSize = Math.max(1, Math.floor(Math.pow(speed, 1.8)));
        const currentIdx = currentIdxRef.current;
        const split = splitIndexRef.current;
        let limit = Math.min(currentIdx + batchSize, totalVisited);

        // Special handling for Waypoint transition:
        // If we cross the 'split' index, we stop exactly there to allow a visual reset
        const crossingSplit = waypointNode && currentIdx < split && limit >= split;
        
        if (crossingSplit) {
           limit = split; 
        }

        // Update Visited Nodes (Visual Blue Layer)
        setVisitedNodes(prev => {
            const next = crossingSplit ? new Set<string>() : new Set(prev);
            for (let i = currentIdx; i < limit; i++) {
                next.add(fullVisitedOrderRef.current[i]);
            }
            return next;
        });

        // Update Parents (Visual Tree Lines)
        setVisitedParents(prev => {
            const next = crossingSplit ? new Map<string, string>() : new Map(prev);
            const maps = previousMapsRef.current;
            for (let i = currentIdx; i < limit; i++) {
                const nodeId = fullVisitedOrderRef.current[i];
                const mapToUse = i < split ? maps[0] : maps[1];
                if (mapToUse && mapToUse.has(nodeId)) {
                    next.set(nodeId, mapToUse.get(nodeId)!);
                }
            }
            return next;
        });

        // If we hit the waypoint, show the path for Leg 1 immediately and clear exploration
        if (crossingSplit) {
            setPath(leg1PathRef.current);
            hasResetForWaypointRef.current = true;
        }

        currentIdxRef.current = limit;

        // Finish Animation
        if (limit >= totalVisited) {
            window.clearInterval(intervalId);
            setIsRunning(false);
            setPath(fullPathRef.current);
            setStats(statsRef.current);
        }
    }, 16); // ~60 FPS

    return () => window.clearInterval(intervalId);
  }, [isRunning, isPaused, speed, waypointNode]);

  // Click handler to set start/end/waypoint based on current interaction mode
  const handleNodeClick = (nodeId: string) => {
    if (isRunning || appMode === 'dev') return;
    if (path.length > 0) handleReset();
    if (mode === InteractionMode.SELECT_START) setStartNode(nodeId);
    else if (mode === InteractionMode.SELECT_END) setEndNode(nodeId);
    else if (mode === InteractionMode.ADD_WAYPOINT) setWaypointNode(nodeId);
  };

  const handleEdgeClick = (edgeId: string) => {
      if (isRunning || appMode === 'dev') return;
      if (mode === InteractionMode.BLOCK_ROAD) {
          setBlockedEdges(prev => {
              const next = new Set(prev);
              if (next.has(edgeId)) next.delete(edgeId);
              else next.add(edgeId);
              return next;
          });
      }
  }

  // Auto-reset visuals when algorithm changes
  useEffect(() => { handleReset(); }, [algorithm]);

  return (
    <div className={`w-screen h-screen relative font-sans selection:bg-blue-500/30 overflow-hidden transition-colors duration-300 ${darkMode ? 'bg-gray-950 text-white' : 'bg-gray-100 text-gray-900'}`}>
      
      {/* Global Loading Overlay */}
      {isLoading && (
           <div className={`absolute inset-0 z-50 flex items-center justify-center backdrop-blur-[2px] ${darkMode ? 'bg-gray-950/50' : 'bg-gray-100/50'}`}>
                <div className={`px-6 py-4 rounded-xl flex items-center gap-3 border shadow-2xl ${darkMode ? 'bg-gray-900 border-gray-700 text-gray-200' : 'bg-white border-gray-200 text-gray-800'}`}>
                    <svg className="animate-spin h-5 w-5 text-blue-500" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                    <span className="font-medium">Downloading Road Network...</span>
                </div>
           </div>
      )}

      {/* Control Panel Sidebar */}
      <Controls 
        algorithm={algorithm} setAlgorithm={setAlgorithm}
        mode={mode} setMode={setMode}
        onRun={runVisualization} onReset={handleReset} onClearBlockages={handleClearBlockages}
        onClearCache={handleClearCache}
        onFileUpload={handleFileUpload} onFetchRoads={handleFetchRoads}
        isRunning={isRunning} isPaused={isPaused} onTogglePause={togglePause}
        isLoading={isLoading} speed={speed} setSpeed={setSpeed}
        stats={stats} viewport={viewport} hasGraph={!!graph} graph={graph}
        darkMode={darkMode} setDarkMode={setDarkMode} onStartTutorial={() => setShowTutorial(true)}
        appMode={appMode} setAppMode={setAppMode}
        customAlgorithms={customAlgorithms} onCustomAlgorithmUpload={handleCustomAlgorithmUpload}
      />
      
      {/* Tutorial Overlay */}
      <Tutorial isActive={showTutorial} onClose={() => setShowTutorial(false)} darkMode={darkMode} />
      
      {/* Main Visualization Canvas */}
      <MapCanvas graph={graph} path={path} visitedNodes={visitedNodes} visitedParents={visitedParents}
          startNodeId={startNode} endNodeId={endNode} waypointNodeId={waypointNode}
          blockedEdgeIds={blockedEdges} mode={mode} viewport={viewport} setViewport={setViewport}
          onNodeClick={handleNodeClick} onEdgeClick={handleEdgeClick} onMapClick={() => {}} darkMode={darkMode} />
    </div>
  );
};

export default App;