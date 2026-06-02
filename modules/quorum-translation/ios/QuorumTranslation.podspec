require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'QuorumTranslation'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platform       = :ios, '13.4'
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/quilibrium/quorum-mobile' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # NaturalLanguage (detection) is available since iOS 12 and linked normally.
  # Translation (iOS 18+) is weak-linked and only touched under @available, so
  # the app keeps running on iOS < 18 (the feature reports itself unavailable).
  s.frameworks      = 'NaturalLanguage', 'SwiftUI', 'UIKit'
  s.weak_frameworks = 'Translation'

  s.source_files = "*.swift"
end
