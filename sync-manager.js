// Gestor de sincronización
class SyncManager {
    constructor() {
        this.isOnline = navigator.onLine;
        this.isSyncing = false;
        this.lastSync = localStorage.getItem('lastSync') || null;
        this.deviceId = localStorage.getItem('deviceId') || this.generateDeviceId();
        this.autoSync = localStorage.getItem('autoSync') !== 'false';
        this.syncInterval = 30000; // 30 segundos
        this.conflictQueue = [];
        
        // Inicializar
        this.init();
    }

    generateDeviceId() {
        const id = `device-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('deviceId', id);
        return id;
    }

    init() {
        // Detectar cambios en conexión
        window.addEventListener('online', () => this.handleOnline());
        window.addEventListener('offline', () => this.handleOffline());
        
        // Sincronización automática periódica
        if (this.autoSync) {
            this.startAutoSync();
        }
        
        // Detectar cambios en IndexedDB
        this.setupDatabaseListeners();
    }

    handleOnline() {
        this.isOnline = true;
        this.updateSyncStatus('online');
        this.log('Conectado a internet', 'success');
        
        // Sincronizar inmediatamente al conectarse
        if (this.autoSync) {
            this.syncWithGitHub();
        }
    }

    handleOffline() {
        this.isOnline = false;
        this.updateSyncStatus('offline');
        this.log('Sin conexión a internet', 'warning');
    }

    updateSyncStatus(status) {
        const element = document.getElementById('sync-status');
        if (element) {
            element.className = `sync-status ${status}`;
            const icon = element.querySelector('i');
            
            switch(status) {
                case 'online':
                    icon.className = 'fas fa-wifi';
                    element.innerHTML = `<i class="fas fa-wifi"></i> En línea`;
                    break;
                case 'offline':
                    icon.className = 'fas fa-wifi-slash';
                    element.innerHTML = `<i class="fas fa-wifi-slash"></i> Sin conexión`;
                    break;
                case 'syncing':
                    icon.className = 'fas fa-sync fa-spin';
                    element.innerHTML = `<i class="fas fa-sync fa-spin"></i> Sincronizando...`;
                    break;
            }
        }
    }

    startAutoSync() {
        setInterval(() => {
            if (this.isOnline && !this.isSyncing && githubConfig.isConfigured()) {
                this.syncWithGitHub();
            }
        }, this.syncInterval);
    }

    async syncWithGitHub() {
        if (!githubConfig.isConfigured() || this.isSyncing || !this.isOnline) {
            return;
        }

        this.isSyncing = true;
        this.updateSyncStatus('syncing');
        
        try {
            // Obtener datos locales
            const localTasks = await window.taskManager.getAllTasks();
            const localData = {
                tasks: localTasks,
                lastSync: new Date().toISOString(),
                deviceId: this.deviceId,
                deviceName: this.getDeviceName()
            };

            // Obtener datos remotos
            const remoteData = await githubConfig.getData();
            
            if (!remoteData) {
                this.log('Error al obtener datos remotos', 'error');
                return;
            }

            // Resolver conflictos y fusionar datos
            const mergedData = this.mergeData(localData.tasks, remoteData.tasks || []);
            
            // Actualizar dispositivos conectados
            const devices = this.updateDevicesList(remoteData.devices || []);
            
            // Preparar datos para guardar
            const dataToSave = {
                tasks: mergedData,
                lastSync: new Date().toISOString(),
                devices: devices,
                version: '1.0'
            };

            // Guardar en GitHub
            const result = await githubConfig.saveData(dataToSave);
            
            if (result.success) {
                // Actualizar localmente con los datos fusionados
                await window.taskManager.syncTasks(mergedData);
                
                // Actualizar última sincronización
                this.lastSync = new Date().toISOString();
                localStorage.setItem('lastSync', this.lastSync);
                this.updateLastSyncDisplay();
                
                this.log('Sincronización completada exitosamente', 'success');
                this.showNotification('Datos sincronizados', 'success');
            } else {
                this.log(`Error al guardar: ${result.error}`, 'error');
            }
        } catch (error) {
            this.log(`Error en sincronización: ${error.message}`, 'error');
        } finally {
            this.isSyncing = false;
            this.updateSyncStatus(this.isOnline ? 'online' : 'offline');
        }
    }

    mergeData(localTasks, remoteTasks) {
        // Crear mapas para acceso rápido
        const localMap = new Map(localTasks.map(task => [task.id, task]));
        const remoteMap = new Map(remoteTasks.map(task => [task.id, task]));
        
        const mergedTasks = [];
        const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);
        
        for (const id of allIds) {
            const localTask = localMap.get(id);
            const remoteTask = remoteMap.get(id);
            
            if (!localTask) {
                // Solo existe en remoto
                mergedTasks.push(remoteTask);
            } else if (!remoteTask) {
                // Solo existe en local
                mergedTasks.push(localTask);
            } else {
                // Existe en ambos, resolver conflicto
                const mergedTask = this.resolveConflict(localTask, remoteTask);
                mergedTasks.push(mergedTask);
            }
        }
        
        return mergedTasks.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    }

    resolveConflict(localTask, remoteTask) {
        const localTime = new Date(localTask.updatedAt || 0);
        const remoteTime = new Date(remoteTask.updatedAt || 0);
        
        // Por defecto, usar el más reciente
        if (localTime > remoteTime) {
            return localTask;
        } else if (remoteTime > localTime) {
            return remoteTask;
        } else {
            // Si son iguales, priorizar local
            return localTask;
        }
    }

    updateDevicesList(existingDevices) {
        const deviceInfo = {
            id: this.deviceId,
            name: this.getDeviceName(),
            lastSeen: new Date().toISOString(),
            online: this.isOnline
        };
        
        // Actualizar o agregar este dispositivo
        const deviceIndex = existingDevices.findIndex(d => d.id === this.deviceId);
        if (deviceIndex >= 0) {
            existingDevices[deviceIndex] = deviceInfo;
        } else {
            existingDevices.push(deviceInfo);
        }
        
        // Limpiar dispositivos inactivos (más de 7 días)
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        return existingDevices.filter(device => 
            new Date(device.lastSeen) > sevenDaysAgo
        );
    }

    getDeviceName() {
        return localStorage.getItem('deviceName') || 
               `Dispositivo-${this.deviceId.substr(-4)}`;
    }

    updateLastSyncDisplay() {
        const element = document.getElementById('last-sync');
        if (element && this.lastSync) {
            const date = new Date(this.lastSync);
            const timeString = date.toLocaleTimeString('es-ES', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            element.querySelector('span').textContent = timeString;
        }
    }

    log(message, type = 'info') {
        const logContainer = document.getElementById('sync-log');
        if (!logContainer) return;
        
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry log-${type}`;
        logEntry.innerHTML = `
            <span class="log-time">${new Date().toLocaleTimeString()}</span>
            <span class="log-message">${message}</span>
        `;
        
        logContainer.prepend(logEntry);
        
        // Limitar a 50 entradas
        const entries = logContainer.querySelectorAll('.log-entry');
        if (entries.length > 50) {
            entries[entries.length - 1].remove();
        }
    }

    showNotification(message, type = 'info') {
        // Implementar notificaciones push si el navegador lo soporta
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('SyncTasks', {
                body: message,
                icon: '/icon.png'
            });
        }
        
        // Mostrar notificación en la UI
        this.createToastNotification(message, type);
    }

    createToastNotification(message, type) {
        const toast = document.createElement('div');
        toast.className = `toast-notification toast-${type}`;
        toast.innerHTML = `
            <i class="fas fa-${type === 'success' ? 'check-circle' : 
                             type === 'error' ? 'exclamation-circle' : 
                             'info-circle'}"></i>
            <span>${message}</span>
        `;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);
        
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    setupDatabaseListeners() {
        // Escuchar cambios en IndexedDB
        if (window.taskManager && window.taskManager.db) {
            // Esta función debe ser implementada en taskManager.js
            // para notificar cuando hay cambios locales
        }
    }

    // Método para sincronización manual
    async manualSync() {
        if (this.isSyncing) {
            this.log('Ya se está sincronizando...', 'warning');
            return;
        }
        
        this.log('Iniciando sincronización manual...', 'info');
        await this.syncWithGitHub();
    }
}

// Instancia global
const syncManager = new SyncManager();