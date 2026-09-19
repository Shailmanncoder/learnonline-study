const db = require('../config/db');

// Central Permission Matrix
const PERMISSIONS = {
    class_owner: [
        'VIEW_CLASSROOM',
        'EDIT_CLASSROOM',
        'ARCHIVE_CLASSROOM',
        'TRANSFER_OWNERSHIP',
        'MANAGE_TEACHERS',
        'APPROVE_STUDENT',
        'REJECT_STUDENT',
        'BLOCK_STUDENT',
        'MANAGE_ROSTER',
        'CREATE_ASSIGNMENT',
        'GRADE_ASSIGNMENT',
        'POST_ANNOUNCEMENT',
        'VIEW_FACULTY_CHAT',
        'SEND_FACULTY_MESSAGE',
        'MANAGE_CLASS_CODE',
        'VIEW_AUDIT_LOGS'
    ],
    class_teacher: [
        'VIEW_CLASSROOM',
        'EDIT_CLASSROOM',
        'APPROVE_STUDENT',
        'REJECT_STUDENT',
        'BLOCK_STUDENT',
        'MANAGE_ROSTER',
        'CREATE_ASSIGNMENT',
        'GRADE_ASSIGNMENT',
        'POST_ANNOUNCEMENT',
        'VIEW_FACULTY_CHAT',
        'SEND_FACULTY_MESSAGE',
        'MANAGE_CLASS_CODE',
        'VIEW_AUDIT_LOGS'
    ],
    subject_teacher: [
        'VIEW_CLASSROOM',
        'CREATE_ASSIGNMENT',
        'GRADE_ASSIGNMENT',
        'POST_ANNOUNCEMENT',
        'VIEW_FACULTY_CHAT',
        'SEND_FACULTY_MESSAGE'
    ],
    student: [
        'VIEW_CLASSROOM',
        'SUBMIT_ASSIGNMENT',
        'VIEW_ACADEMICS'
    ]
};

async function logSecurityEvent(actorId, eventType, req, details = '') {
    try {
        const ip = (req && req.headers && req.headers['x-forwarded-for']) || (req && req.socket && req.socket.remoteAddress) || '';
        const endpoint = req ? `${req.method} ${req.originalUrl || req.url}` : '';
        await db.run(
            'INSERT INTO security_logs (actor_id, event_type, ip_address, endpoint, details) VALUES (?, ?, ?, ?, ?)',
            [actorId || null, eventType, ip, endpoint, typeof details === 'object' ? JSON.stringify(details) : String(details)]
        );
    } catch (e) {
        console.error('[SECURITY_LOG_ERROR]', e.message);
    }
}

async function logClassroomAudit(classId, actorId, action, targetUserId = null, metadata = {}) {
    try {
        await db.run(
            'INSERT INTO classroom_audit_logs (classroom_id, actor_id, action, target_user_id, metadata) VALUES (?, ?, ?, ?, ?)',
            [classId, actorId, action, targetUserId, JSON.stringify(metadata)]
        );
    } catch (e) {
        console.error('[AUDIT_LOG_ERROR]', e.message);
    }
}

function requireClassroomPermission(requiredPermission) {
    return async (req, res, next) => {
        const userId = req.user && req.user.id;
        const classId = req.params.id || req.params.classId || req.body.class_id || req.body.classroom_id;

        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!classId) {
            return res.status(400).json({ error: 'Classroom ID is required' });
        }

        try {
            const classroom = await db.get('SELECT * FROM classrooms WHERE id = ? AND deleted_at IS NULL', [classId]);
            if (!classroom) {
                return res.status(404).json({ error: 'Classroom not found' });
            }

            const membership = await db.get(
                'SELECT * FROM class_memberships WHERE classroom_id = ? AND user_id = ?',
                [classId, userId]
            );

            const isOwner = Number(classroom.owner_teacher_id) === Number(userId) || Number(classroom.created_by) === Number(userId);
            const userRole = isOwner ? 'class_owner' : (membership ? membership.role : (req.user.role === 'admin' ? 'class_owner' : null));

            if (!userRole) {
                await logSecurityEvent(userId, 'PERMISSION_DENIED_NOT_MEMBER', req, { classId, requiredPermission });
                return res.status(403).json({ error: 'Forbidden: You are not a member of this classroom' });
            }

            if (userRole === 'student') {
                if (!membership || membership.status !== 'approved') {
                    await logSecurityEvent(userId, 'STUDENT_UNAPPROVED_ACCESS_ATTEMPT', req, { classId, status: membership ? membership.status : 'none' });
                    return res.status(403).json({
                        error: 'Access pending or restricted',
                        membership_status: membership ? membership.status : 'not_enrolled',
                        rejection_reason: (membership && membership.rejection_reason) || null
                    });
                }
            }

            const allowedPermissions = PERMISSIONS[userRole] || [];
            if (!allowedPermissions.includes(requiredPermission)) {
                await logSecurityEvent(userId, 'PERMISSION_DENIED_ROLE_MISMATCH', req, { classId, userRole, requiredPermission });
                return res.status(403).json({
                    error: `Forbidden: Role '${userRole}' lacks permission '${requiredPermission}'`
                });
            }

            req.classroom = classroom;
            req.membership = membership || { role: userRole, status: 'approved' };
            req.classroomRole = userRole;

            next();
        } catch (err) {
            console.error('[PERMISSION_CHECK_ERROR]', err);
            return res.status(500).json({ error: 'Internal authorization error' });
        }
    };
}

module.exports = {
    PERMISSIONS,
    requireClassroomPermission,
    logSecurityEvent,
    logClassroomAudit
};
