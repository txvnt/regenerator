module.exports = {
  CallExpression(path) {
    let influentialExpression = false;
    path.traverse({
      Identifier(path) {
        let parent = path.context.parentPath;
        if (
          (parent.node.type != "MemberExpression" ||
            parent.node.object.name == path.node.name) &&
          dependencies.some((dependency) => dependency.name == path.node.name)
        ) {
          influentialExpression = true;
          path.stop;
        }
      },
    });

    if (influentialExpression) {
      path.traverse({
        Identifier(path) {
          let parent = path.context.parentPath;
          if (
            parent.node.type != "MemberExpression" ||
            parent.node.object.name == path.node.name
          ) {
            if (
              !dependencies.some(
                (dependency) => dependency.name == path.node.name
              )
            ) {
              if (!(path.node.name in { console: null })) {
                dependencies.push({ name: path.node.name, type: "normal" });
              }
            }
          }
        },
      });
    }
  },
};
