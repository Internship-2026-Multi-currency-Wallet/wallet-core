import { GraphQLError, Kind, type SelectionSetNode, type ValidationRule } from 'graphql';

/** A leaf field counts 1; fragments add no depth of their own. */
export function maxDepthRule(maxDepth: number): ValidationRule {
  return (context) => {
    // Memoized so fragment chains stay linear; 0 while a fragment is measured stops cycles (NoFragmentCycles reports them).
    const fragmentDepths = new Map<string, number>();

    const depthOf = (selectionSet: SelectionSetNode): number => {
      let deepest = 0;
      for (const selection of selectionSet.selections) {
        let depth = 0;
        if (selection.kind === Kind.FIELD) {
          depth = 1 + (selection.selectionSet ? depthOf(selection.selectionSet) : 0);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          depth = depthOf(selection.selectionSet);
        } else {
          const name = selection.name.value;
          const fragment = context.getFragment(name);
          if (fragmentDepths.has(name)) {
            depth = fragmentDepths.get(name) ?? 0;
          } else if (fragment) {
            fragmentDepths.set(name, 0);
            depth = depthOf(fragment.selectionSet);
            fragmentDepths.set(name, depth);
          }
        }
        deepest = Math.max(deepest, depth);
      }
      return deepest;
    };

    return {
      OperationDefinition(node) {
        const depth = depthOf(node.selectionSet);
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(`Query depth ${depth} exceeds the limit of ${maxDepth}`, {
              nodes: node,
            }),
          );
        }
      },
    };
  };
}
