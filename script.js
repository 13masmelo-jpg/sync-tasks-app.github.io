// Base de datos IndexedDB con Dexie.js
class TaskManager {
    constructor() {
        this.db = new Dexie('SyncTasksDB');
        
        // Esquema de la base de datos
        this.db.version(1).stores({
            tasks: '++id, title, completed, priority, category, deadline, createdAt, updatedAt, synced'
        });
        
        this.init();
    }

    async init() {
        await this.db.open();
        console.log('✅ Base de datos IndexedDB inicializada');
    }

    // CRUD operations
    async addTask(taskData) {
        const task = {
            ...taskData,
            completed: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            synced: false,
            deviceId: syncManager.deviceId
        };

        const id = await this.db.tasks.add(task);
        
        // Notificar al sync manager
        if (syncManager.autoSync && syncManager.isOnline) {
            setTimeout(() => syncManager.syncWithGitHub(), 1000);
        }
        
        return { ...task, id };
    }

    async updateTask(id, updates) {
        updates.updatedAt = new Date().toISOString();
        updates.synced = false;
        
        await this.db.tasks.update(id, updates);
        
        // Notificar al sync manager
        if (syncManager.autoSync && syncManager.isOnline) {
            setTimeout(() => syncManager.syncWithGitHub(), 1000);
        }
        
        return await this.getTask(id);
    }

    async deleteTask(id) {
        // Marcar como eliminado en lugar de borrar físicamente
        await this.db.tasks.update(id, {
            deleted: true,
            updatedAt: new Date().toISOString(),
            synced: false
        });
        
        // Notificar al sync manager
        if (syncManager.autoSync && syncManager.isOnline) {
            setTimeout(() => syncManager.syncWithGitHub(), 1000);
        }
        
        return true;
    }

    async getTask(id) {
        return await this.db.tasks.get(id);
    }

    async getAllTasks(filter = 'all') {
        let tasks = await this.db.tasks.toArray();
        
        // Filtrar tareas eliminadas
        tasks = tasks.filter(task => !task.deleted);
        
        switch(filter) {
            case 'completed':
                return tasks.filter(task => task.completed);
            case 'pending':
                return tasks.filter(task => !task.completed);
            case 'today':
                const today = new Date().toDateString();
                return tasks.filter(task => 
                    task.deadline && 
                    new Date(task.deadline).toDateString() === today
                );
            default:
                return tasks;
        }
    }

    // Sincronización
    async syncTasks(remoteTasks) {
        // Implementar lógica de sincronización bidireccional
        // Esto es una implementación simplificada
        
        for (const remoteTask of remoteTasks) {
            if (remoteTask.deleted) {
                // Eliminar localmente
                await this.db.tasks.delete(remoteTask.id);
                continue;
            }
            
            const localTask = await this.getTask(remoteTask.id);
            
            if (!localTask) {
                // Nueva tarea remota
                await this.db.tasks.add({
                    ...remoteTask,
                    synced: true
                });
            } else {
                // Actualizar si es más reciente
                const localTime = new Date(localTask.updatedAt || 0);
                const remoteTime = new Date(remoteTask.updatedAt || 0);
                
                if (remoteTime > localTime) {
                    await this.db.tasks.update(remoteTask.id, {
                        ...remoteTask,
                        synced: true
                    });
                }
            }
        }
        
        // Marcar todas las tareas locales como sincronizadas
        await this.db.tasks.toCollection().modify({ synced: true });
    }

    // Estadísticas
    async getStats() {
        const tasks = await this.getAllTasks();
        
        return {
            total: tasks.length,
            completed: tasks.filter(t => t.completed).length,
            pending: tasks.filter(t => !t.completed).length,
            highPriority: tasks.filter(t => t.priority === 'high').length,
            today: tasks.filter(t => {
                if (!t.deadline) return false;
                const today = new Date().toDateString();
                return new Date(t.deadline).toDateString() === today;
            }).length
        };
    }
}

// Inicialización de la aplicación
document.addEventListener('DOMContentLoaded', async () => {
    // Inicializar managers
    window.taskManager = new TaskManager();
    
    // Configurar UI
    setupUI();
    setupEventListeners();
    
    // Cargar tareas iniciales
    await loadTasks();
    
    // Verificar conexión a GitHub
    if (githubConfig.isConfigured()) {
        document.getElementById('github-status').textContent = 'Conectado';
        if (syncManager.isOnline) {
            syncManager.syncWithGitHub();
        }
    }
    
    // Actualizar estado inicial
    updateStats();
    syncManager.updateLastSyncDisplay();
});

// Configuración de la UI
function setupUI() {
    // Generar nombre de dispositivo si no existe
    if (!localStorage.getItem('deviceName')) {
        const deviceName = `Mi-${navigator.platform.substr(0, 3)}-${Math.random().toString(36).substr(2, 4)}`;
        localStorage.setItem('deviceName', deviceName);
        document.getElementById('device-name').textContent = deviceName;
    } else {
        document.getElementById('device-name').textContent = localStorage.getItem('deviceName');
    }
}

// Configurar event listeners
function setupEventListeners() {
    // Formulario de tareas
    document.getElementById('task-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const title = document.getElementById('task-title').value.trim();
        if (!title) return;
        
        const taskData = {
            title: title,
            description: document.getElementById('task-description').value.trim(),
            priority: document.querySelector('input[name="priority"]:checked').value,
            category: document.getElementById('task-category').value,
            deadline: document.getElementById('task-deadline').value || null
        };
        
        await window.taskManager.addTask(taskData);
        await loadTasks();
        
        // Limpiar formulario
        e.target.reset();
        document.getElementById('task-title').focus();
    });
    
    // Botones de sincronización
    document.getElementById('manual-sync').addEventListener('click', () => {
        syncManager.manualSync();
    });
    
    document.getElementById('force-sync').addEventListener('click', () => {
        syncManager.manualSync();
    });
    
    // Configuración de GitHub
    document.getElementById('github-login').addEventListener('click', () => {
        document.getElementById('github-modal').style.display = 'flex';
    });
    
    document.querySelector('.close-modal').addEventListener('click', () => {
        document.getElementById('github-modal').style.display = 'none';
    });
    
    document.getElementById('save-github-config').addEventListener('click', async () => {
        const token = document.getElementById('github-token').value;
        const username = document.getElementById('github-username').value;
        const repo = document.getElementById('github-repo').value;
        
        if (!token || !username || !repo) {
            alert('Por favor, completa todos los campos');
            return;
        }
        
        githubConfig.saveConfig(token, username, repo);
        
        // Probar conexión
        const result = await githubConfig.testConnection();
        
        if (result.success) {
            alert('✅ Configuración guardada exitosamente');
            document.getElementById('github-modal').style.display = 'none';
            document.getElementById('github-status').textContent = 'Conectado';
            
            // Sincronizar inmediatamente
            if (syncManager.isOnline) {
                syncManager.syncWithGitHub();
            }
        } else {
            alert(`❌ Error: ${result.error}`);
        }
    });
    
    // Filtros
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            await loadTasks(btn.dataset.filter);
        });
    });
    
    // Configuración de sincronización
    document.getElementById('auto-sync').addEventListener('change', (e) => {
        localStorage.setItem('autoSync', e.target.checked);
        syncManager.autoSync = e.target.checked;
    });
}

// Cargar y mostrar tareas
async function loadTasks(filter = 'all') {
    const tasks = await window.taskManager.getAllTasks(filter);
    const container = document.getElementById('tasks-list');
    
    if (tasks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-tasks fa-3x"></i>
                <h3>No hay tareas</h3>
                <p>${filter === 'all' ? '¡Agrega tu primera tarea!' : 
                   filter === 'completed' ? 'No hay tareas completadas' : 
                   filter === 'today' ? 'No hay tareas para hoy' : 
                   'No hay tareas pendientes'}</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = tasks.map(task => `
        <div class="task-item ${task.completed ? 'completed' : ''} ${task.priority}-priority">
            <div class="sync-indicator ${task.synced ? 'synced' : 'pending'}"></div>
            
            <div class="task-content">
                <div class="task-header">
                    <h3 class="task-title">
                        <input type="checkbox" 
                               class="task-checkbox" 
                               ${task.completed ? 'checked' : ''}
                               data-id="${task.id}">
                        <span>${task.title}</span>
                    </h3>
                    <div class="task-meta">
                        <span class="task-category ${task.category}">${task.category}</span>
                        <span class="task-priority ${task.priority}">${getPriorityText(task.priority)}</span>
                        ${task.deadline ? `<span class="task-deadline ${isOverdue(task.deadline) ? 'overdue' : ''}">
                            <i class="fas fa-calendar"></i> ${formatDate(task.deadline)}
                        </span>` : ''}
                    </div>
                </div>
                
                ${task.description ? `<p class="task-description">${task.description}</p>` : ''}
                
                <div class="task-footer">
                    <span class="task-time">
                        <i class="far fa-clock"></i> ${formatDate(task.updatedAt, true)}
                    </span>
                    <div class="task-actions">
                        <button class="btn-icon edit-task" data-id="${task.id}" title="Editar">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-icon delete-task" data-id="${task.id}" title="Eliminar">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
    
    // Añadir event listeners a los checkboxes
    document.querySelectorAll('.task-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', async (e) => {
            const id = parseInt(e.target.dataset.id);
            await window.taskManager.updateTask(id, { 
                completed: e.target.checked 
            });
            await loadTasks(filter);
            updateStats();
        });
    });
    
    // Añadir event listeners a los botones
    document.querySelectorAll('.delete-task').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const id = parseInt(e.target.closest('.delete-task').dataset.id);
            if (confirm('¿Eliminar esta tarea?')) {
                await window.taskManager.deleteTask(id);
                await loadTasks(filter);
                updateStats();
            }
        });
    });
}

// Actualizar estadísticas
async function updateStats() {
    const stats = await window.taskManager.getStats();
    
    document.getElementById('total-tasks').textContent = stats.total;
    document.getElementById('completed-tasks').textContent = stats.completed;
    document.getElementById('pending-tasks').textContent = stats.pending;
    document.getElementById('high-priority-tasks').textContent = stats.highPriority;
    
    // Mini estadísticas
    document.getElementById('total-tasks-mini').textContent = stats.total;
    document.getElementById('completed-tasks-mini').textContent = stats.completed;
    document.getElementById('pending-tasks-mini').textContent = stats.pending;
    
    // Resumen
    document.getElementById('summary-total').textContent = stats.total;
    document.getElementById('summary-pending').textContent = stats.pending;
    document.getElementById('summary-synced').textContent = stats.total; // Simplificado
}

// Funciones de utilidad
function getPriorityText(priority) {
    const texts = {
        low: 'Baja',
        medium: 'Media',
        high: 'Alta'
    };
    return texts[priority] || priority;
}

function formatDate(dateString, timeOnly = false) {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    
    if (timeOnly) {
        return date.toLocaleTimeString('es-ES', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    }
    
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
        return 'Hoy';
    } else if (diffDays === 1) {
        return 'Ayer';
    } else if (diffDays < 7) {
        return `Hace ${diffDays} días`;
    } else {
        return date.toLocaleDateString('es-ES');
    }
}

function isOverdue(deadline) {
    if (!deadline) return false;
    return new Date(deadline) < new Date();
}