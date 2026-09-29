import { createElement } from "react";
import type { AgentIcon as AgentIconData, AgentId } from "../../shared/types/agents";
import { FillSvg, LARGER, Svg } from "./icons";
import { useAgents } from "./use-agents";

interface AgentIconProps {
  agentId: AgentId;
  className?: string;
}

/**
 * An agent's icon, drawn from the data its definition carries (AgentInfo.icon), so nothing here
 * names an agent. Nothing until the agents are listed (useAgents), or for an id none has.
 */
export function AgentIcon({ agentId, className }: AgentIconProps) {
  const icon = useAgents().find((agent) => agent.id === agentId)?.icon;
  return icon ? <DrawnIcon icon={icon} className={className} /> : null;
}

function DrawnIcon({ icon, className }: { icon: AgentIconData; className?: string }) {
  const shapes = icon.shapes.map((shape, index) => createElement(shape.element, { key: index, ...shape.attributes }));
  if (icon.kind === "fill") {
    // FillSvg takes its scale divided into the extent.
    return (
      <FillSvg
        className={className}
        extent={icon.larger ? icon.extent / LARGER : icon.extent}
        cx={icon.cx}
        cy={icon.cy}
        grid={icon.grid}
        shapeRendering={icon.crisp ? "crispEdges" : undefined}
      >
        {shapes}
      </FillSvg>
    );
  }
  return (
    <Svg className={className} extent={icon.extent} cx={icon.cx} cy={icon.cy} scale={icon.larger ? LARGER : 1} stroke={icon.stroke}>
      {shapes}
    </Svg>
  );
}
