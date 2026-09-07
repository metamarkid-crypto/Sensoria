import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity } from 'react-native';
import { LANGUAGES, useTranslation } from '../../i18n';

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * Shared trilingual picker for the settings rows. Renders the same options as
 * the Role Selection globe modal, with a light haptic on selection.
 */
export default function LanguagePickerModal({ visible, onClose }: Props) {
  const { language, setLanguage, t } = useTranslation();

  const handleSelect = (code: typeof language) => {
    setLanguage(code);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.container}>
          <Text style={styles.title}>{t('settings.languageModalTitle')}</Text>

          {LANGUAGES.map((lang) => {
            const isActive = language === lang.code;
            return (
              <TouchableOpacity
                key={lang.code}
                style={[styles.langBtn, isActive && styles.langBtnActive]}
                onPress={() => handleSelect(lang.code)}
                activeOpacity={0.7}
              >
                <Text style={[styles.langBtnText, isActive && styles.langBtnTextActive]}>
                  {lang.flag} {lang.label}
                </Text>
                {isActive ? <Text style={styles.check}>✓</Text> : null}
              </TouchableOpacity>
            );
          })}

          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  container: {
    backgroundColor: '#FFF',
    padding: 24,
    borderRadius: 20,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#334155',
    marginBottom: 16,
    textAlign: 'center',
  },
  langBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    marginBottom: 12,
  },
  langBtnActive: {
    borderColor: '#2488FF',
    backgroundColor: '#EFF6FF',
  },
  langBtnText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#64748B',
  },
  langBtnTextActive: {
    color: '#2488FF',
  },
  check: {
    fontSize: 16,
    fontWeight: '900',
    color: '#2488FF',
  },
  cancelBtn: {
    marginTop: 8,
    alignItems: 'center',
    padding: 10,
  },
  cancelText: {
    color: '#94A3B8',
    fontWeight: 'bold',
    fontSize: 16,
  },
});