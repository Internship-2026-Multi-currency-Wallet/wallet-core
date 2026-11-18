import { GraphQLError, Kind, type SelectionSetNode, type ValidationRule } from 'graphql';

/**
 * Refuses an operation whose fields nest deeper than `maxDepth`. A leaf field counts 1, a field
 * with a selection set 1 plus its deepest selection; fragments add no depth of their own.
 */
export function maxDepthRule(maxDepth: number): ValidationRule {
  return (context) => {
    // Per fragment, so a document that spreads fragments in a chain is measured in linear time.
    // A fragment still being measured counts 0: that stops cycles, which NoFragmentCycles reports.
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
