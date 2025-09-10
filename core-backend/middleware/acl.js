exports.canReadDoc = (user, doc) => {
  if (!user) return false;
  if ((user.role||'').includes('admin')) return true;
  if (doc.access.visibility === 'org') return true;
  if (doc.access.visibility === 'private') {
    return doc.access.owners?.includes(user.sub) || doc.createdBy === user.sub;
  }
  // 'restricted'
  return doc.access.owners?.includes(user.sub) ||
         doc.access.viewers?.includes(user.sub) ||
         doc.createdBy === user.sub;
};

exports.canEditDoc = (user, doc) => {
  if (!user) return false;
  if ((user.role||'').includes('admin')) return true;
  return doc.access.owners?.includes(user.sub) || doc.createdBy === user.sub;
};

exports.isAdmin = (user) => (user?.role||'') === 'admin' || (user?.role||'') === 'superadmin';
