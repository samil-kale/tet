import { createElement } from "react";
import type { AgentIcon as AgentIconData, AgentId, AgentInfo } from "../../shared/types/agents";
import type { ContextMenuEntry } from "./ContextMenu";
import { FillSvg, Svg } from "./icons";
import { agentInfo, useAgents } from "./use-agents";

interface AgentIconProps {
  agentId: AgentId;
  className?: string;
}

/**
 * An agent's icon, drawn from the data its definition carries (AgentInfo.icon), so nothing here
 * names an agent. Nothing until the agents are listed (useAgents), or for an id none has.
 */
export function AgentIcon({ agentId, className }: AgentIconProps) {
  const icon = agentInfo(useAgents(), agentId)?.icon;
  return icon ? <DrawnIcon icon={icon} className={className} /> : null;
}

/** An agent as a menu entry: its icon, then its name. */
export function agentEntry(agent: AgentInfo, run: () => void): ContextMenuEntry {
  return { label: agent.displayName, icon: <AgentIcon agentId={agent.id} className="tab-icon" />, run };
}

function DrawnIcon({ icon, className }: { icon: AgentIconData; className?: string }) {
  const shapes = icon.shapes.map((shape, index) => createElement(shape.element, { key: index, ...shape.attributes }));
  if (icon.kind === "fill") {
    return (
      <FillSvg className={className} extent={icon.extent} cx={icon.cx} cy={icon.cy} shapeRendering={icon.crisp ? "crispEdges" : undefined}>
        {shapes}
      </FillSvg>
    );
  }
  return (
    <Svg className={className} extent={icon.extent} cx={icon.cx} cy={icon.cy} stroke={icon.stroke}>
      {shapes}
    </Svg>
  );
}
